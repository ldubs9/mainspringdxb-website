const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'supabase/migrations/20260801_discount_codes.sql');
const inventoryFinalizationMigration = path.join(root, 'supabase/migrations/20260807_payment_finalizes_inventory.sql');
const referenceAndEmailRoutingMigration = path.join(root, 'supabase/migrations/20260809_order_reference_codes_and_email_routing.sql');
const prerequisiteMigrations = [
    path.join(root, 'supabase/migrations/20260723_atomic_checkout_inventory.sql'),
    path.join(root, 'supabase/migrations/20260731_order_email_outbox.sql'),
    path.join(root, 'supabase/migrations/20260731_repair_order_status_trigger.sql'),
];

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function commandAvailable(command) {
    try {
        execFileSync(command, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

async function withPostgres(run) {
    for (const command of ['initdb', 'pg_ctl', 'psql']) {
        assert.equal(commandAvailable(command), true, `${command} is required for database behavior tests`);
    }

    const clusterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mainspring-discounts-pg-'));
    const dataDir = path.join(clusterDir, 'data');
    const logPath = path.join(clusterDir, 'postgres.log');
    const port = await freePort();
    const socketDir = path.join('/tmp', `mainspring-pg-${process.pid}-${port}`);
    fs.mkdirSync(socketDir);
    const env = {
        ...process.env,
        LC_ALL: 'C',
        PGHOST: socketDir,
        PGPORT: String(port),
        PGDATABASE: 'postgres',
    };
    let started = false;

    try {
        execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '--no-locale', '-E', 'UTF8'], { env, stdio: 'pipe' });
        try {
            execFileSync(
                'pg_ctl',
                ['-D', dataDir, '-l', logPath, '-o', `-F -p ${port} -k ${socketDir}`, '-w', 'start'],
                { env, stdio: 'pipe' }
            );
        } catch (error) {
            const postgresLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'No PostgreSQL log was created.';
            error.message += `\nPostgreSQL log:\n${postgresLog}`;
            throw error;
        }
        started = true;

        const psql = (...args) => execFileSync(
            'psql',
            ['-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args],
            { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim();
        const psqlAsync = (...args) => new Promise((resolve) => {
            execFile(
                'psql',
                ['-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args],
                { env, encoding: 'utf8' },
                (error, stdout, stderr) => resolve({
                    ok: !error,
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                })
            );
        });
        const apply = (file) => psql('-f', file);

        apply(path.join(root, 'tests/fixtures/mainspring-checkout-base.sql'));
        prerequisiteMigrations.forEach(apply);
        apply(migrationPath);
        apply(inventoryFinalizationMigration);
        apply(referenceAndEmailRoutingMigration);
        await run({ psql, psqlAsync });
    } finally {
        if (started) {
            execFileSync('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { env, stdio: 'pipe' });
        }
        fs.rmSync(clusterDir, { recursive: true, force: true });
        fs.rmSync(socketDir, { recursive: true, force: true });
    }
}

test('discounted order remains authoritative through email and payment lifecycle', async () => {
    assert.equal(fs.existsSync(migrationPath), true, 'forward discount migration exists');

    await withPostgres(async ({ psql }) => {
        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, category, subcategory, price, status)
            VALUES
                (101, 'Rolex', 'Datejust', 'watches', 'automatic', 1000, 'available');

            INSERT INTO public.mainspring_discount_codes
                (code, discount_type, discount_value, usage_limit, per_customer_limit)
            VALUES ('SAVE10', 'percentage', 10, 2, 1);
        `);

        const order = JSON.parse(psql('-At', '-c', `
            SELECT row_to_json(result)
            FROM public.create_mainspring_order(
                'MS-DISCOUNT-1',
                'Test Customer',
                'customer@example.com',
                '+971500000001',
                'Dubai',
                '[{"id":101,"qty":1}]'::jsonb,
                'ziina',
                'desktop',
                'database-test',
                ' save10 '
            ) AS result;
        `));

        assert.equal(Number(order.subtotal_aed), 1000);
        assert.equal(order.discount_code, 'SAVE10');
        assert.equal(Number(order.discount_aed), 100);
        assert.equal(Number(order.discounted_subtotal_aed), 900);
        assert.equal(Number(order.surcharge_pct), 3);
        assert.equal(Number(order.total_aed), 927);
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 101;'), 'available');

        const redemption = JSON.parse(psql('-At', '-c', `
            SELECT row_to_json(r)
            FROM (
                SELECT status, discount_aed
                FROM public.mainspring_discount_redemptions
                WHERE order_id = (SELECT id FROM public.mainspring_orders WHERE order_ref = 'MS-DISCOUNT-1')
            ) AS r;
        `));
        assert.equal(redemption.status, 'reserved');
        assert.equal(Number(redemption.discount_aed), 100);

        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_order_email_events
            WHERE order_id = (SELECT id FROM public.mainspring_orders WHERE order_ref = 'MS-DISCOUNT-1');
        `), '0', 'pending Ziina orders do not queue owner email');

        psql('-c', `
            UPDATE public.mainspring_orders
            SET payment_status = 'processing'
            WHERE order_ref = 'MS-DISCOUNT-1';
            UPDATE public.mainspring_orders
            SET payment_status = 'pending'
            WHERE order_ref = 'MS-DISCOUNT-1';
        `);
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 101;'), 'available');

        psql('-c', `
            UPDATE public.mainspring_orders
            SET payment_status = 'paid'
            WHERE order_ref = 'MS-DISCOUNT-1';
        `);

        const emailEvent = JSON.parse(psql('-At', '-c', `
            SELECT order_data
            FROM public.claim_mainspring_order_email_events(2)
            WHERE event_type = 'payment_confirmed_business';
        `));
        assert.equal(emailEvent.discount_code, 'SAVE10');
        assert.equal(Number(emailEvent.discount_aed), 100);
        assert.equal(Number(emailEvent.discounted_subtotal_aed), 900);

        assert.equal(psql('-At', '-c', `
            SELECT status
            FROM public.mainspring_discount_redemptions
            WHERE order_id = (SELECT id FROM public.mainspring_orders WHERE order_ref = 'MS-DISCOUNT-1');
        `), 'redeemed');
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 101;'), 'sold');
    });
});

test('concurrent payment finalization can sell a watch only once', async () => {
    await withPostgres(async ({ psql, psqlAsync }) => {
        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, category, price, status)
            VALUES (150, 'Rolex', 'Shared Watch', 'watches', 1200, 'available');

            SELECT *
            FROM public.create_mainspring_order(
                'MS-PAID-RACE-1', 'Payment Race One', 'one@example.com', '+971****0101', 'Dubai',
                '[{"id":150,"qty":1}]'::jsonb, 'ziina', NULL, NULL, NULL
            );
            SELECT *
            FROM public.create_mainspring_order(
                'MS-PAID-RACE-2', 'Payment Race Two', 'two@example.com', '+971****0102', 'Dubai',
                '[{"id":150,"qty":1}]'::jsonb, 'ziina', NULL, NULL, NULL
            );
        `);

        const finalize = (orderRef) => psqlAsync('-c', `
            UPDATE public.mainspring_orders
            SET payment_status = 'paid'
            WHERE order_ref = '${orderRef}';
        `);
        const results = await Promise.all([
            finalize('MS-PAID-RACE-1'),
            finalize('MS-PAID-RACE-2'),
        ]);

        assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 150;'), 'sold');
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_orders
            WHERE order_ref IN ('MS-PAID-RACE-1', 'MS-PAID-RACE-2')
              AND payment_status = 'paid';
        `), '1');
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_orders
            WHERE order_ref IN ('MS-PAID-RACE-1', 'MS-PAID-RACE-2')
              AND payment_status = 'pending';
        `), '1');
    });
});

test('failed and cancelled payment transitions leave inventory available', async () => {
    await withPostgres(async ({ psql }) => {
        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, category, price, status)
            VALUES
                (160, 'Omega', 'Failed Payment Watch', 'watches', 900, 'available'),
                (161, 'Tudor', 'Cancelled Payment Watch', 'watches', 950, 'available');

            SELECT *
            FROM public.create_mainspring_order(
                'MS-FAILED-PAYMENT', 'Failed Payment', 'failed@example.com', '+971****0160', 'Dubai',
                '[{"id":160,"qty":1}]'::jsonb, 'bank_transfer', NULL, NULL, NULL
            );
            SELECT *
            FROM public.create_mainspring_order(
                'MS-CANCELLED-PAYMENT', 'Cancelled Payment', 'cancelled@example.com', '+971****0161', 'Dubai',
                '[{"id":161,"qty":1}]'::jsonb, 'bank_transfer', NULL, NULL, NULL
            );

            UPDATE public.mainspring_orders
            SET payment_status = 'failed'
            WHERE order_ref = 'MS-FAILED-PAYMENT';
            UPDATE public.mainspring_orders
            SET payment_status = 'cancelled'
            WHERE order_ref = 'MS-CANCELLED-PAYMENT';
        `);

        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 160;'), 'available');
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 161;'), 'available');
    });
});

test('legacy order RPC delegates without reserving inventory during rollout', async () => {
    await withPostgres(async ({ psql }) => {
        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, category, price, status)
            VALUES (162, 'Cartier', 'Legacy RPC Watch', 'watches', 1100, 'available');
        `);

        const result = JSON.parse(psql('-At', '-c', `
            SELECT row_to_json(result)
            FROM public.create_mainspring_order_with_reservation(
                'MS-LEGACY-RPC', 'Legacy RPC', 'legacy@example.com', '+971****0162', 'Dubai',
                '[{"id":162,"qty":1}]'::jsonb, 'bank_transfer', NULL, NULL, NULL
            ) AS result;
        `));

        assert.equal(result.reservation_expires_at, null);
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 162;'), 'available');
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'mainspring_products'
              AND column_name IN ('reservation_expires_at', 'reserved_by_order_id', 'reservation_previous_status');
        `), '0');
    });
});

test('validation enforces dates, targeting, caps, minimums, and released usage', async () => {
    await withPostgres(async ({ psql }) => {
        assert.equal(psql('-At', '-c', `
            INSERT INTO public.mainspring_orders (
                order_ref, customer_name, customer_email, customer_phone,
                customer_address, items, subtotal_aed, surcharge_pct,
                total_aed, payment_method
            ) VALUES (
                'MS-LEGACY-INSERT', 'Legacy Caller', 'legacy@example.com', '+971500000009',
                'Dubai', '[]'::jsonb, 500, 0, 500, 'bank_transfer'
            )
            RETURNING discounted_subtotal_aed;
        `), '500.00');
        psql('-c', "DELETE FROM public.mainspring_orders WHERE order_ref = 'MS-LEGACY-INSERT';");

        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, category, subcategory, price, status)
            VALUES
                (201, 'Rolex', 'Explorer', 'watches', 'automatic', 1000, 'available'),
                (202, 'Mainspring', 'Strap', 'accessories', 'straps', 500, 'available');

            INSERT INTO public.mainspring_discount_codes
                (code, discount_type, discount_value, maximum_discount_aed, minimum_subtotal_aed, starts_at, expires_at, status)
            VALUES
                ('CAPPED50', 'percentage', 50, 200, 0, NULL, NULL, 'active'),
                ('EXPIRED10', 'percentage', 10, NULL, 0, NULL, NOW() - INTERVAL '1 minute', 'active'),
                ('FUTURE10', 'percentage', 10, NULL, 0, NOW() + INTERVAL '1 hour', NULL, 'active'),
                ('PAUSED10', 'percentage', 10, NULL, 0, NULL, NULL, 'paused'),
                ('MINIMUM10', 'percentage', 10, NULL, 2000, NULL, NULL, 'active'),
                ('WATCH100', 'fixed_aed', 100, NULL, 0, NULL, NULL, 'active'),
                ('RELEASE10', 'percentage', 10, NULL, 0, NULL, NULL, 'active');

            INSERT INTO public.mainspring_discount_targets
                (discount_code_id, target_type, product_id)
            SELECT id, 'product', 201
            FROM public.mainspring_discount_codes
            WHERE code = 'WATCH100';

            UPDATE public.mainspring_discount_codes
            SET usage_limit = 1
            WHERE code = 'RELEASE10';
        `);

        const validate = (code, items, phone = '+971500000010') => JSON.parse(psql('-At', '-c', `
            SELECT row_to_json(result)
            FROM public.validate_mainspring_discount(
                '${code}',
                '${JSON.stringify(items)}'::jsonb,
                '${phone}'
            ) AS result;
        `));

        const capped = validate('CAPPED50', [{ id: 201, qty: 1 }]);
        assert.equal(capped.valid, true);
        assert.equal(Number(capped.discount_aed), 200);

        assert.match(validate('EXPIRED10', [{ id: 201, qty: 1 }]).message, /expired/i);
        assert.match(validate('FUTURE10', [{ id: 201, qty: 1 }]).message, /not active yet/i);
        assert.match(validate('PAUSED10', [{ id: 201, qty: 1 }]).message, /not valid/i);
        assert.match(validate('MINIMUM10', [{ id: 201, qty: 1 }]).message, /minimum subtotal/i);
        assert.match(validate('WATCH100', [{ id: 202, qty: 1 }]).message, /does not apply/i);

        const targeted = validate('WATCH100', [{ id: 201, qty: 1 }, { id: 202, qty: 1 }]);
        assert.equal(targeted.valid, true);
        assert.equal(Number(targeted.eligible_subtotal_aed), 1000);
        assert.equal(Number(targeted.discount_aed), 100);
        assert.equal(Number(targeted.discounted_subtotal_aed), 1400);

        psql('-c', `
            SELECT *
            FROM public.create_mainspring_order(
                'MS-RELEASE-1', 'Release Test', 'release@example.com', '+971****0011', 'Dubai',
                '[{"id":201,"qty":1}]'::jsonb, 'bank_transfer', NULL, NULL, 'RELEASE10'
            );
        `);
        assert.equal(validate('RELEASE10', [{ id: 202, qty: 1 }]).valid, false);

        psql('-c', `
            UPDATE public.mainspring_orders
            SET payment_status = 'failed'
            WHERE order_ref = 'MS-RELEASE-1';
        `);
        assert.equal(validate('RELEASE10', [{ id: 202, qty: 1 }]).valid, true);
        assert.equal(psql('-At', '-c', `
            SELECT status
            FROM public.mainspring_discount_redemptions
            WHERE order_id = (SELECT id FROM public.mainspring_orders WHERE order_ref = 'MS-RELEASE-1');
        `), 'released');
        assert.equal(psql('-At', '-c', 'SELECT status FROM public.mainspring_products WHERE id = 201;'), 'available');
    });
});

test('concurrent orders cannot both consume the final discount use', async () => {
    await withPostgres(async ({ psql, psqlAsync }) => {
        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, category, price, status)
            VALUES
                (301, 'Rolex', 'One', 'watches', 1000, 'available'),
                (302, 'Rolex', 'Two', 'watches', 1000, 'available');
            INSERT INTO public.mainspring_discount_codes
                (code, discount_type, discount_value, usage_limit)
            VALUES ('LASTUSE', 'percentage', 10, 1);
        `);

        const call = (orderRef, productId, phone) => psqlAsync('-c', `
            SELECT *
            FROM public.create_mainspring_order(
                '${orderRef}', 'Concurrency Test', 'concurrency@example.com', '${phone}', 'Dubai',
                '[{"id":${productId},"qty":1}]'::jsonb, 'bank_transfer', NULL, NULL, 'LASTUSE'
            );
        `);
        const results = await Promise.all([
            call('MS-CONCURRENT-1', 301, '+971500000021'),
            call('MS-CONCURRENT-2', 302, '+971500000022'),
        ]);

        assert.deepEqual(results.map(result => result.ok).sort(), [false, true]);
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_discount_redemptions
            WHERE status IN ('reserved', 'redeemed');
        `), '1');
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_orders
            WHERE order_ref IN ('MS-CONCURRENT-1', 'MS-CONCURRENT-2');
        `), '1');
    });
});

test('order snapshots and status history use reference codes while Ziina waits for paid email', async () => {
    assert.equal(fs.existsSync(referenceAndEmailRoutingMigration), true, 'forward reference migration exists');

    await withPostgres(async ({ psql }) => {
        psql('-c', `
            INSERT INTO public.mainspring_products
                (id, brand, model, reference_code, image_urls, category, price, status)
            VALUES
                (401, 'Omega', 'Ziina Watch', 'REF-ZIINA', ARRAY['https://cdn.example.com/ziina.jpg'], 'watches', 1000, 'available'),
                (402, 'Rolex', 'Bank Watch', 'REF-BANK', ARRAY['https://cdn.example.com/bank.jpg'], 'watches', 1100, 'available'),
                (403, 'Cartier', 'Cash Watch', 'REF-CASH', ARRAY['https://cdn.example.com/cash.jpg'], 'watches', 1200, 'available');

            SELECT * FROM public.create_mainspring_order(
                'MS-REF-ZIINA', 'Ziina Customer', 'ziina@example.com', '+971500000401', 'Dubai',
                '[{"id":401,"qty":1}]'::jsonb, 'ziina', NULL, NULL, NULL
            );
            SELECT * FROM public.create_mainspring_order(
                'MS-REF-BANK', 'Bank Customer', 'bank@example.com', '+971500000402', 'Dubai',
                '[{"id":402,"qty":1}]'::jsonb, 'bank_transfer', NULL, NULL, NULL
            );
            SELECT * FROM public.create_mainspring_cash_order(
                'MS-REF-CASH', 'Cash Customer', 'cash@example.com', '+971500000403', 'Dubai',
                '[{"id":403,"qty":1}]'::jsonb, 'cash_in_store', NULL, NULL, NULL
            );
        `);

        const ziinaOrder = JSON.parse(psql('-At', '-c', `
            SELECT jsonb_build_object(
                'reference_codes', reference_codes,
                'reference_code', items->0->>'reference_code',
                'thumbnail_url', items->0->>'thumbnail_url'
            )
            FROM public.mainspring_orders
            WHERE order_ref = 'MS-REF-ZIINA';
        `));
        assert.deepEqual(ziinaOrder.reference_codes, ['REF-ZIINA']);
        assert.equal(ziinaOrder.reference_code, 'REF-ZIINA');
        assert.equal(ziinaOrder.thumbnail_url, 'https://cdn.example.com/ziina.jpg');

        psql('-c', `
            UPDATE public.mainspring_products
            SET reference_code = 'REF-ZIINA-CHANGED',
                image_urls = ARRAY['https://cdn.example.com/changed.jpg']
            WHERE id = 401;
            UPDATE public.mainspring_orders
            SET items = items
            WHERE order_ref = 'MS-REF-ZIINA';
        `);
        assert.equal(psql('-At', '-c', `
            SELECT (items->0->>'reference_code') || '|' || (items->0->>'thumbnail_url')
            FROM public.mainspring_orders
            WHERE order_ref = 'MS-REF-ZIINA';
        `), 'REF-ZIINA|https://cdn.example.com/ziina.jpg', 'stored watch snapshots remain immutable');

        assert.equal(psql('-At', '-c', `
            SELECT reference_codes[1]
            FROM public.mainspring_order_status_history
            WHERE order_id = (SELECT id FROM public.mainspring_orders WHERE order_ref = 'MS-REF-ZIINA')
            ORDER BY created_at
            LIMIT 1;
        `), 'REF-ZIINA');

        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_order_email_events AS e
            JOIN public.mainspring_orders AS o ON o.id = e.order_id
            WHERE o.order_ref = 'MS-REF-ZIINA';
        `), '0');

        psql('-c', `
            INSERT INTO public.mainspring_order_email_events (
                order_id, event_type, status, attempts, locked_at
            )
            SELECT id, 'order_created_business', 'processing', 1, NOW() - INTERVAL '20 minutes'
            FROM public.mainspring_orders
            WHERE order_ref = 'MS-REF-ZIINA';
        `);
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.claim_mainspring_order_email_events(10)
            WHERE event_type = 'order_created_business'
              AND order_data->>'order_ref' = 'MS-REF-ZIINA';
        `), '0', 'stale Ziina creation events are never reclaimed');
        psql('-c', `
            DELETE FROM public.mainspring_order_email_events
            WHERE order_id = (SELECT id FROM public.mainspring_orders WHERE order_ref = 'MS-REF-ZIINA')
              AND event_type = 'order_created_business';
        `);
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_order_email_events AS e
            JOIN public.mainspring_orders AS o ON o.id = e.order_id
            WHERE o.order_ref IN ('MS-REF-BANK', 'MS-REF-CASH')
              AND e.event_type = 'order_created_business';
        `), '2');

        assert.equal(psql('-At', '-c', `
            SELECT payment_method || '|' || reference_codes[1]
            FROM public.mainspring_orders
            WHERE order_ref = 'MS-REF-CASH';
        `), 'cash_in_store|REF-CASH');

        assert.equal(psql('-At', '-c', `
            SELECT e.reference_codes[1]
            FROM public.mainspring_order_email_events AS e
            JOIN public.mainspring_orders AS o ON o.id = e.order_id
            WHERE o.order_ref = 'MS-REF-CASH'
              AND e.event_type = 'order_created_business';
        `), 'REF-CASH');

        psql('-c', `
            UPDATE public.mainspring_orders
            SET payment_status = 'paid'
            WHERE order_ref = 'MS-REF-ZIINA';
        `);
        assert.equal(psql('-At', '-c', `
            SELECT COUNT(*)
            FROM public.mainspring_order_email_events AS e
            JOIN public.mainspring_orders AS o ON o.id = e.order_id
            WHERE o.order_ref = 'MS-REF-ZIINA'
              AND e.event_type IN ('payment_confirmed_business', 'payment_confirmed_customer');
        `), '2');
    });
});
