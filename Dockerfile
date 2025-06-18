FROM node:23-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/
COPY views/ ./views/
COPY sql/ ./sql/

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["node", "src/server/index.js"]