# MariaDB Integration

This document explains the MariaDB integration added to improve search performance.

## What Changed

- **Faster Search**: Event searches now use MariaDB with proper indexing instead of loading entire JSON files into memory
- **Better Performance**: Full-text search capabilities and optimized queries
- **Scalability**: Database can handle thousands of events efficiently
- **Backward Compatibility**: Falls back to original JSON cache system if database is unavailable

## Setup Instructions

### 1. Environment Variables

Add these variables to your `.env` file:

```bash
# Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_NAME=vorel
DB_USER=vorel
DB_PASSWORD=your_secure_password_here
DB_ROOT_PASSWORD=your_root_password_here
```

### 2. Docker Setup

The `docker-compose.yml` file has been updated to include MariaDB. To start with database:

```bash
# Start all services including MariaDB
docker-compose up -d

# Check if database is running
docker-compose ps
```

### 3. Migration

To migrate your existing JSON cache data to MariaDB:

```bash
# Install new dependencies
npm install

# Run setup script
npm run setup-db

# Or manually migrate
node -e "require('./src/server/helpers/migration').migrateFromCache()"
```

### 4. Verification

Check that everything is working:

```bash
# Check database status
curl http://localhost:3002/api/db-status

# Test search (should be faster now)
curl "http://localhost:3002/api/events/search?q=ontario"
```

## Database Schema

The main table structure:

```sql
CREATE TABLE events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(50) UNIQUE NOT NULL,
    year INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(100),
    state_prov VARCHAR(50),
    country VARCHAR(50) DEFAULT 'USA',
    start_date DATE,
    end_date DATE,
    raw_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes for fast searching
    INDEX idx_year (year),
    INDEX idx_name (name),
    FULLTEXT(name, city, state_prov, event_key)
);
```

## API Endpoints

New endpoints for database management:

- `GET /api/db-status` - Database connection and statistics
- `POST /api/migrate` - Manual migration trigger

## Fallback Behavior

If MariaDB is unavailable, the system automatically falls back to the original JSON cache system. This ensures reliability during database maintenance or connection issues.

## Performance Improvements

Expected performance improvements:

- **Search Speed**: ~10-50x faster depending on dataset size
- **Memory Usage**: ~90% less memory for search operations
- **Concurrent Access**: Better handling of multiple simultaneous searches
- **Fuzzy Matching**: Built-in SOUNDEX and LIKE pattern matching

## Troubleshooting

### Database Connection Issues

1. Check that MariaDB is running: `docker-compose ps`
2. Verify environment variables in `.env`
3. Check logs: `docker-compose logs mariadb`

### Migration Issues

1. Ensure cache files exist in `.cache/` directory
2. Check database permissions
3. Run migration manually: `npm run setup-db`

### Search Not Working

1. Check `/api/db-status` endpoint
2. Verify events are in database
3. Check application logs for errors

The system will automatically fall back to cache-based search if database issues occur.
