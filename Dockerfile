FROM node:23-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/
COPY views/ ./views/

# Set environment variables
ENV NODE_ENV=production

# Note: PORT is handled via environment variables (no need to expose when using Traefik)
# Traefik will route to the container automatically

# Start the application
CMD ["node", "src/server/index.js"]