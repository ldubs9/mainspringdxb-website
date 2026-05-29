FROM denoland/deno:runtime-1.32.4

WORKDIR /app

# Copy the handler
COPY index.ts ./

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
