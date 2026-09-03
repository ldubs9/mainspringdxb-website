(function initializeMainspringSupabase(root) {
    'use strict';

    if (!root.supabase || typeof root.supabase.createClient !== 'function') {
        throw new Error('Supabase client library failed to load');
    }

    const config = Object.freeze({
        url: 'https://sldb.swiftloop.tech',
        anonKey: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc3NTgzMjI0MCwiZXhwIjo0OTMxNTA1ODQwLCJyb2xlIjoiYW5vbiJ9.G7a98S-SVHYk1h5hU2VjVmbu_RF42KOK8jVDrR1kOZM',
    });

    function createStorefrontClient() {
        return root.supabase.createClient(config.url, config.anonKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        });
    }

    function createAdminClient() {
        return root.supabase.createClient(config.url, config.anonKey, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: true,
                storageKey: 'mainspring-admin-auth',
            },
        });
    }

    root.MainspringSupabase = Object.freeze({
        config,
        createAdminClient,
        createStorefrontClient,
    });
})(window);
