# --- Stage 1: Build Stage ---
# Use a full Node.js image for installing dependencies
FROM node:20-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker layer caching
COPY package*.json ./

# Install dependencies. We skip devDependencies for the final stage.
RUN npm install --omit=dev

# Copy the rest of the application source code
COPY . .

# --- Stage 2: Production Stage ---
# Use a minimal base image (alpine is great for small size)
FROM node:20-alpine

# Cloud Run has no TUN device. Tailscale runs in userspace as the non-root
# service account and exposes an HTTP proxy only on this container's loopback.
COPY --from=tailscale/tailscale:v1.104.1@sha256:87c55d6be56ad85b3d8bceca5f87f73de288c609131460dd1be1874c250cc41d /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale/tailscale:v1.104.1@sha256:87c55d6be56ad85b3d8bceca5f87f73de288c609131460dd1be1874c250cc41d /usr/local/bin/tailscale /usr/local/bin/tailscale

# Set the working directory
WORKDIR /app

# Copy only the production dependencies and built application from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app ./
COPY tailscale-start.sh /app/tailscale-start.sh

# Cloud Run automatically sets the PORT environment variable.
# Your application must listen on the port defined by this variable.
# Express apps often need this defined in their server setup.
ENV PORT 8080
EXPOSE 8080

# The serving process and any future in-process self-improvement agent cannot
# overwrite mission, authorization code, or model adapters in this image.
# Only reports are writable. Deployment/image replacement remains owner-only.
RUN mkdir -p /app/reports/self-review && chown -R node:node /app/reports
USER node

# Run the 'start' script defined in your package.json
# CMD is the preferred instruction for running the service
CMD [ "sh", "/app/tailscale-start.sh" ]
