const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/igfetch-daily.yml'), 'utf8');
const fetcher = fs.readFileSync(path.join(root, 'scripts/igfetch_fetch.py'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'scripts/igfetch_run.sh'), 'utf8');
const checker = fs.readFileSync(path.join(root, 'scripts/igfetch_check.py'), 'utf8');
const home = fs.readFileSync(path.join(root, 'components/page-home.html'), 'utf8');
const contact = fs.readFileSync(path.join(root, 'components/page-contact.html'), 'utf8');
const footer = fs.readFileSync(path.join(root, 'components/footer.html'), 'utf8');
const faq = fs.readFileSync(path.join(root, 'components/page-faq.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

test('Instagram fetch targets the current Mainspring account', () => {
    assert.match(workflow, /--username mainspring\.ae\b/);
    assert.match(workflow, /INSTAGRAM_USER_ID:\s*['"]52804570589['"]/);
    assert.match(fetcher, /DEFAULT_USERNAME\s*=\s*["']mainspring\.ae["']/);
    assert.match(fetcher, /os\.environ\.get\(['"]INSTAGRAM_USER_ID['"]\)/);
    assert.ok(
        fetcher.indexOf('configured_user_id =') < fetcher.indexOf('profile_url ='),
        'a configured ID is selected before the username profile lookup'
    );
    assert.match(fetcher, /parser\.add_argument\(["']--username["'][\s\S]*default=DEFAULT_USERNAME/);
    assert.match(runner, /USERNAME=\$\{USERNAME:-mainspring\.ae\}/);
    assert.match(checker, /--username mainspring\.ae\b/);

    for (const source of [workflow, fetcher, runner, checker]) {
        assert.doesNotMatch(source, /mainspring\.dxb/);
    }
});

test('Instagram links and empty-state copy use the current account', () => {
    assert.match(home, /https:\/\/www\.instagram\.com\/mainspring\.ae/);
    assert.match(contact, /https:\/\/www\.instagram\.com\/mainspring\.ae/);
    assert.match(footer, /https:\/\/www\.instagram\.com\/mainspring\.ae/);
    assert.match(faq, /<strong>@mainspring\.ae<\/strong>[^<]*on Instagram/);
    assert.match(app, /Follow @mainspring\.ae on Instagram/);
    assert.match(app, /https:\/\/www\.instagram\.com\/mainspring\.ae/);
});
