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

# Set the working directory
WORKDIR /app

# Copy only the production dependencies and built application from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app ./

# Cloud Run automatically sets the PORT environment variable.
# Your application must listen on the port defined by this variable.
# Express apps often need this defined in their server setup.
ENV PORT 8080
EXPOSE 8080

# Run the 'start' script defined in your package.json
# CMD is the preferred instruction for running the service
CMD [ "npm", "start" ]