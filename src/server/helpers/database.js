const mariadb = require('mariadb');
require('dotenv').config();

// Create connection pool
const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'vorel',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'vorel',
  connectionLimit: 10,
  acquireTimeout: 60000,
  timeout: 60000,
  // MariaDB specific optimizations
  charset: 'utf8mb4',
  timezone: 'UTC'
});

// Test database connection
async function testConnection() {
  let conn;
  try {
    conn = await pool.getConnection();
    console.log('MariaDB connection established successfully');
    return true;
  } catch (err) {
    console.error('MariaDB connection failed:', err.message);
    return false;
  } finally {
    if (conn) conn.release();
  }
}

// Search events using MariaDB
async function searchEventsDB(query, limit = 10) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    if (!query || query.trim().length === 0) {
      return [];
    }
    
    const searchQuery = query.trim();
    
    // Use full-text search if query is complex enough, otherwise use LIKE
    let sql, params;
    
    if (searchQuery.split(' ').length > 1) {
      // Multi-word query - use full-text search
      sql = `
        SELECT 
          \`key\`, name, location, date, year, start_date
        FROM event_search_view 
        WHERE MATCH(name, location) AGAINST(? IN NATURAL LANGUAGE MODE)
           OR \`key\` LIKE ?
        ORDER BY 
          CASE 
            WHEN \`key\` LIKE ? THEN 1
            WHEN name LIKE ? THEN 2
            ELSE 3
          END,
          year DESC, start_date
        LIMIT ?
      `;
      params = [searchQuery, `%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`, limit];
    } else {
      // Single word query - use LIKE for better partial matching
      sql = `
        SELECT 
          \`key\`, name, location, date, year, start_date
        FROM event_search_view 
        WHERE name LIKE ?
           OR location LIKE ?
           OR \`key\` LIKE ?
        ORDER BY 
          CASE 
            WHEN \`key\` LIKE ? THEN 1
            WHEN name LIKE ? THEN 2
            WHEN location LIKE ? THEN 3
            ELSE 4
          END,
          year DESC, start_date
        LIMIT ?
      `;
      const likeQuery = `%${searchQuery}%`;
      const exactQuery = `%${searchQuery}%`;
      params = [likeQuery, likeQuery, likeQuery, exactQuery, exactQuery, exactQuery, limit];
    }
    
    const results = await conn.query(sql, params);
    
    return results.map(row => ({
      key: row.key,
      name: row.name,
      location: row.location,
      date: row.date
    }));
    
  } catch (err) {
    console.error('Error searching events in database:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Insert or update event in database
async function upsertEvent(eventData) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const sql = `
      INSERT INTO events (
        event_key, year, name, city, state_prov, country, 
        start_date, end_date, week, event_type, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        city = VALUES(city),
        state_prov = VALUES(state_prov),
        country = VALUES(country),
        start_date = VALUES(start_date),
        end_date = VALUES(end_date),
        week = VALUES(week),
        event_type = VALUES(event_type),
        raw_data = VALUES(raw_data),
        updated_at = CURRENT_TIMESTAMP
    `;
    
    const params = [
      eventData.key,
      eventData.year,
      eventData.name,
      eventData.city || null,
      eventData.state_prov || null,
      eventData.country || 'USA',
      eventData.start_date || null,
      eventData.end_date || null,
      eventData.week || null,
      eventData.event_type || null,
      eventData.raw_data ? JSON.stringify(eventData.raw_data) : null
    ];
    
    const result = await conn.query(sql, params);
    return result;
    
  } catch (err) {
    console.error('Error upserting event:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Bulk insert events (for migration)
async function bulkInsertEvents(events) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    await conn.beginTransaction();
    
    const sql = `
      INSERT IGNORE INTO events (
        event_key, year, name, city, state_prov, country, 
        start_date, end_date, week, event_type, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    for (const event of events) {
      const params = [
        event.key,
        event.year,
        event.name,
        event.city || null,
        event.state_prov || null,
        event.country || 'USA',
        event.start_date || null,
        event.end_date || null,
        event.week || null,
        event.event_type || null,
        event.raw_data ? JSON.stringify(event.raw_data) : null
      ];
      
      await conn.query(sql, params);
    }
      await conn.commit();
    console.log(`Bulk inserted ${events.length} events`);
    
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('Error bulk inserting events:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Get database statistics
async function getDBStats() {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const stats = await conn.query(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(DISTINCT year) as years_count,
        MIN(year) as earliest_year,
        MAX(year) as latest_year,
        AVG(CASE WHEN year >= 2025 THEN 1 ELSE 0 END) * 100 as recent_events_percent
      FROM events
    `);
    
    return stats[0];
    
  } catch (err) {
    console.error('Error getting database stats:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Clean up old events (optional maintenance function)
async function cleanupOldEvents(keepYears = 5) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const cutoffYear = new Date().getFullYear() - keepYears;
    const result = await conn.query(
      'DELETE FROM events WHERE year < ? AND year < 2025', 
      [cutoffYear]
    );
      console.log(`Cleaned up ${result.affectedRows} old events (before ${cutoffYear})`);
    return result.affectedRows;
    
  } catch (err) {
    console.error('Error cleaning up old events:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Initialize database connection and schema
async function initializeDB() {
  console.log('Initializing MariaDB connection...');
  const connected = await testConnection();
  
  if (connected) {
    console.log('Creating database schema if not exists...');
    await createSchema();
    
    const stats = await getDBStats();
    console.log(`Database stats: ${stats.total_events} events across ${stats.years_count} years`);
  }
  
  return connected;
}

// Create database schema
async function createSchema() {
  let conn;
  try {
    conn = await pool.getConnection();
      console.log('Creating events table...');
    
    // Create events table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_key VARCHAR(50) UNIQUE NOT NULL,
        year INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        city VARCHAR(100),
        state_prov VARCHAR(50),
        country VARCHAR(50) DEFAULT 'USA',
        start_date DATE,
        end_date DATE,
        week INT,
        event_type VARCHAR(50),
        -- Store original TBA data as JSON for flexibility
        raw_data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        -- Indexes for fast searching
        INDEX idx_year (year),
        INDEX idx_name (name),
        INDEX idx_location (city, state_prov),
        INDEX idx_event_key (event_key),
        INDEX idx_date_range (start_date, end_date),
        INDEX idx_year_date (year, start_date),
        
        -- Full-text search index for comprehensive text search
        FULLTEXT(name, city, state_prov, event_key)
      )
    `);
    
    console.log('Creating team events table...');
    
    // Create team events table for fast team-to-event lookups
    await conn.query(`
      CREATE TABLE IF NOT EXISTS team_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        team_key VARCHAR(10) NOT NULL,
        event_key VARCHAR(50) NOT NULL,
        year INT NOT NULL,
        event_name VARCHAR(255) NOT NULL,
        city VARCHAR(100),
        state_prov VARCHAR(50),
        start_date DATE,
        end_date DATE,
        cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        -- Unique constraint to prevent duplicates
        UNIQUE KEY unique_team_event (team_key, event_key, year),
        
        -- Indexes for fast lookups
        INDEX idx_team_year (team_key, year),
        INDEX idx_cached_at (cached_at),
        INDEX idx_dates (start_date, end_date)
      )
    `);
    
    console.log('Creating event search view...');
    
    // Create view for formatted search results
    await conn.query(`
      CREATE OR REPLACE VIEW event_search_view AS
      SELECT 
        event_key as \`key\`,
        CONCAT(year, ' ', name) as name,
        CASE 
          WHEN city IS NOT NULL AND state_prov IS NOT NULL THEN CONCAT(city, ', ', state_prov)
          WHEN city IS NOT NULL THEN city
          WHEN state_prov IS NOT NULL THEN state_prov
          ELSE country
        END as location,
        CASE 
          WHEN start_date = end_date THEN DATE_FORMAT(start_date, '%b %e, %Y')
          ELSE CONCAT(DATE_FORMAT(start_date, '%b %e'), ' - ', DATE_FORMAT(end_date, '%b %e, %Y'))
        END as date,
        year,
        start_date,
        end_date
      FROM events
      WHERE year >= 2025
      ORDER BY year DESC, start_date
    `);
    
    console.log('Database schema created successfully!');
    
  } catch (err) {
    console.error('Error creating database schema:', err);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Team Events MariaDB Functions

// Cache team events in MariaDB
async function cacheTeamEventsDB(teamKey, events) {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    
    const currentYear = new Date().getFullYear();
    
    // Delete existing cache for this team and current year only
    await conn.query(
      'DELETE FROM team_events WHERE team_key = ? AND year = ?',
      [teamKey, currentYear]
    );
    
    // Insert new events (only current year)
    if (events.length > 0) {
      const sql = `
        INSERT INTO team_events (
          team_key, event_key, year, event_name, city, state_prov, start_date, end_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      for (const event of events) {
        // Only cache current year events
        if (event.year === currentYear) {
          await conn.query(sql, [
            teamKey,
            event.key,
            event.year || currentYear,
            event.name,
            event.city || null,
            event.state_prov || null,
            event.startDate || null,
            event.endDate || null
          ]);
        }
      }
    }
    
    await conn.commit();
    console.log(`Cache updated for team ${teamKey}`);
    
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('Error caching team events:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Get team events from MariaDB with dynamic status calculation
async function getTeamEventsDB(teamKey) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const currentYear = new Date().getFullYear();
    const currentDate = new Date();
    
    // Check if cache exists and is fresh (1 hour for current year)
    const cacheCheckSql = `
      SELECT cached_at FROM team_events 
      WHERE team_key = ? AND year = ? 
      ORDER BY cached_at DESC 
      LIMIT 1
    `;
    
    const cacheResult = await conn.query(cacheCheckSql, [teamKey, currentYear]);
    
    if (cacheResult.length > 0) {
      const lastCached = new Date(cacheResult[0].cached_at);
      const cacheAge = Date.now() - lastCached.getTime();
      const cacheThreshold = 60 * 60 * 1000; // 1 hour
      
      if (cacheAge < cacheThreshold) {
        // Return cached events with dynamic status calculation
        const eventsSql = `
          SELECT 
            event_key as \`key\`,
            event_name as name,
            CONCAT(
              COALESCE(city, ''), 
              CASE WHEN city IS NOT NULL AND state_prov IS NOT NULL THEN ', ' ELSE '' END,
              COALESCE(state_prov, '')
            ) as location,
            CONCAT(
              DATE_FORMAT(start_date, '%b %e'),
              CASE WHEN start_date != end_date THEN CONCAT(' - ', DATE_FORMAT(end_date, '%b %e')) ELSE '' END,
              ', ', year
            ) as date,
            start_date as startDate,
            end_date as endDate,
            year,
            CONCAT(year, ' ', event_name, ' ', COALESCE(city, ''), ' ', COALESCE(state_prov, ''), ' ', event_key) as searchString
          FROM team_events 
          WHERE team_key = ? AND year = ?
          ORDER BY start_date
        `;
        
        const events = await conn.query(eventsSql, [teamKey, currentYear]);
        
        // Calculate dynamic status and daysDifference
        const formattedEvents = events.map(event => {
          const startDate = new Date(event.startDate);
          const endDate = new Date(event.endDate);
          const daysDifference = Math.abs((currentDate - startDate) / (1000 * 60 * 60 * 24));
          
          let status = 'upcoming';
          if (currentDate >= startDate && currentDate <= endDate) {
            status = 'ongoing';
          } else if (currentDate > endDate) {
            status = 'completed';
          }
          
          return {
            ...event,
            daysDifference,
            status,
            searchString: event.searchString.toLowerCase()
          };
        });
        
        // Sort by priority: ongoing > upcoming (closest) > completed (most recent)
        formattedEvents.sort((a, b) => {
          if (a.status !== b.status) {
            if (a.status === 'ongoing') return -1;
            if (b.status === 'ongoing') return 1;
            if (a.status === 'upcoming' && b.status === 'completed') return -1;
            if (a.status === 'completed' && b.status === 'upcoming') return 1;
          }
          
          if (a.status === 'upcoming') {
            return a.daysDifference - b.daysDifference; // Closest upcoming first
          } else if (a.status === 'completed') {
            return a.daysDifference - b.daysDifference; // Most recent completed first
          } else {
            return new Date(b.startDate) - new Date(a.startDate); // Most recently started ongoing first
          }
        });
        
        return formattedEvents;
      }
    }
    
    // Cache is stale or doesn't exist, return null to trigger fresh fetch
    return null;
    
  } catch (err) {
    console.error('Error getting team events from DB:', err.message);
    return null;
  } finally {
    if (conn) conn.release();
  }
}

// Clear all team event caches (useful for maintenance)
async function clearAllTeamCaches() {
  let conn;
  try {
    conn = await pool.getConnection();
    
    // Use TRUNCATE for faster clearing of all data
    await conn.query('TRUNCATE TABLE team_events');
    console.log('Cleared all team event caches');
    
    return true;
    
  } catch (err) {
    console.error('Error clearing all team caches:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Clear team caches older than specified time (in hours)
async function clearOldTeamCaches(hoursOld = 24) {
  let conn;
  try {
    conn = await pool.getConnection();
    
    const cutoffTime = new Date(Date.now() - (hoursOld * 60 * 60 * 1000));
    
    const result = await conn.query(
      'DELETE FROM team_events WHERE cached_at < ?',
      [cutoffTime]
    );
    
    if (result.affectedRows > 0) {
      console.log(`Cleared ${result.affectedRows} old team event caches (older than ${hoursOld} hours)`);
    }
    
    return result.affectedRows;
    
  } catch (err) {
    console.error('Error clearing old team caches:', err.message);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

// Graceful shutdown
async function closeDB() {
  try {
    await pool.end();
    console.log('MariaDB connection pool closed');
  } catch (err) {
    console.error('Error closing MariaDB pool:', err.message);
  }
}

// Note: Shutdown handlers are now managed by the main server file

module.exports = {
  pool,
  testConnection,
  searchEventsDB,
  upsertEvent,
  bulkInsertEvents,
  getDBStats,
  cleanupOldEvents,
  initializeDB,
  createSchema,
  closeDB,
  cacheTeamEventsDB,
  getTeamEventsDB,
  clearAllTeamCaches,
  clearOldTeamCaches
};
