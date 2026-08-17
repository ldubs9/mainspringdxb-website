FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html

# Files that must never be served from the web root.
RUN rm -rf /usr/share/nginx/html/coolify \
           /usr/share/nginx/html/services \
           /usr/share/nginx/html/scripts \
           /usr/share/nginx/html/supabase \
           /usr/share/nginx/html/tests \
           /usr/share/nginx/html/.github \
           /usr/share/nginx/html/.claude \
           /usr/share/nginx/html/.vscode \
           /usr/share/nginx/html/Dockerfile \
           /usr/share/nginx/html/nginx.conf \
           /usr/share/nginx/html/*.sql \
           /usr/share/nginx/html/*.md \
           /usr/share/nginx/html/igfetch_requirements.txt \
           /usr/share/nginx/html/data/instagram_raw.json

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
