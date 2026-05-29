FROM denoland/deno:runtime-1.32.4

WORKDIR /app

# Copy the function source
COPY index.ts ./

# Expose a port for Coolify/proxy
EXPOSE 8000

# Run the Deno handler with required permissions
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
