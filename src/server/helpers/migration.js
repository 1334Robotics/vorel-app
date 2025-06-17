const fs = require('fs');
const path = require('path');
const { bulkInsertEvents, initializeDB, getDBStats } = require('./database');

// Path to the cache directory
const CACHE_DIR = path.join(__dirname, '../../../.cache');

// Function to migrate data from JSON cache to MariaDB
async function migrateFromCache() {
  try {
    console.log('🚀 Starting migration from JSON cache to MariaDB...');
    
    // Initialize database connection
    const dbConnected = await initializeDB();
    if (!dbConnected) {
      throw new Error('Could not connect to database');
    }
    
    // Check if cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
      console.log('ℹ️  No cache directory found, skipping migration');
      return;
    }
    
    // Read all cache files
    const files = fs.readdirSync(CACHE_DIR);
    const cacheFiles = files.filter(file => file.match(/tba-events-(\d{4})\.json/));
    
    if (cacheFiles.length === 0) {
      console.log('ℹ️  No cache files found, skipping migration');
      return;
    }
    
    console.log(`📁 Found ${cacheFiles.length} cache files to migrate`);
    
    let totalEvents = 0;
    
    // Process each cache file
    for (const file of cacheFiles) {
      const match = file.match(/tba-events-(\d{4})\.json/);
      if (match) {
        const year = parseInt(match[1]);
        const cachePath = path.join(CACHE_DIR, file);
        
        console.log(`📄 Processing ${file}...`);
        
        try {
          const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const events = cacheData.events || [];
          
          if (events.length === 0) {
            console.log(`   ⚠️  No events found in ${file}`);
            continue;
          }
          
          // Transform events to database format
          const dbEvents = events.map(event => ({
            key: event.key,
            year: year,
            name: event.name.replace(`${year} `, ''), // Remove year prefix since it's stored separately
            city: event.city,
            state_prov: event.state_prov,
            country: event.country || 'USA',
            start_date: null, // Will be populated from raw_data if available
            end_date: null,
            week: null,
            event_type: null,
            raw_data: event // Store original event data
          }));
          
          // Bulk insert events
          await bulkInsertEvents(dbEvents);
          totalEvents += events.length;
          
          console.log(`   ✅ Migrated ${events.length} events from ${year}`);
          
        } catch (error) {
          console.error(`   ❌ Error processing ${file}:`, error.message);
        }
      }
    }
    
    console.log(`🎉 Migration completed! Total events migrated: ${totalEvents}`);
    
    // Show final database stats
    const stats = await getDBStats();
    console.log(`📊 Final database stats:`, stats);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

// Function to migrate a single year (for incremental updates)
async function migrateSingleYear(year) {
  try {
    const cachePath = path.join(CACHE_DIR, `tba-events-${year}.json`);
    
    if (!fs.existsSync(cachePath)) {
      console.log(`⚠️  No cache file found for ${year}`);
      return;
    }
    
    console.log(`🔄 Migrating ${year} events to database...`);
    
    const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const events = cacheData.events || [];
    
    if (events.length === 0) {
      console.log(`   ℹ️  No events found for ${year}`);
      return;
    }
    
    // Transform events to database format
    const dbEvents = events.map(event => ({
      key: event.key,
      year: year,
      name: event.name.replace(`${year} `, ''), // Remove year prefix
      city: event.city,
      state_prov: event.state_prov,
      country: event.country || 'USA',
      start_date: null,
      end_date: null,
      week: null,
      event_type: null,
      raw_data: event
    }));
    
    await bulkInsertEvents(dbEvents);
    console.log(`✅ Migrated ${events.length} events for ${year}`);
    
  } catch (error) {
    console.error(`❌ Error migrating ${year}:`, error.message);
    throw error;
  }
}

// Function to check if migration is needed
async function checkMigrationStatus() {
  try {
    const stats = await getDBStats();
    const hasEvents = stats.total_events > 0;
    
    // Check if we have cache files
    const cacheExists = fs.existsSync(CACHE_DIR);
    let cacheFileCount = 0;
    
    if (cacheExists) {
      const files = fs.readdirSync(CACHE_DIR);
      cacheFileCount = files.filter(file => file.match(/tba-events-(\d{4})\.json/)).length;
    }
    
    return {
      hasEvents,
      cacheExists,
      cacheFileCount,
      dbStats: stats
    };
    
  } catch (error) {
    console.error('Error checking migration status:', error.message);
    return {
      hasEvents: false,
      cacheExists: false,
      cacheFileCount: 0,
      dbStats: null
    };
  }
}

module.exports = {
  migrateFromCache,
  migrateSingleYear,
  checkMigrationStatus
};
