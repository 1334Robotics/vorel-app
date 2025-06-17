#!/usr/bin/env node

/**
 * Setup script for MariaDB integration
 * This script helps set up the database and migrate existing data
 */

const readline = require('readline');
const { initializeDB, getDBStats, testConnection } = require('./src/server/helpers/database');
const { migrateFromCache, checkMigrationStatus } = require('./src/server/helpers/migration');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('🚀 Vorel MariaDB Setup\n');
  
  try {
    // Test database connection
    console.log('1. Testing database connection...');
    const connected = await testConnection();
    
    if (!connected) {
      console.log('❌ Database connection failed!');
      console.log('Please check your database configuration in .env file:');
      console.log('- DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD');
      console.log('- Make sure MariaDB is running');
      process.exit(1);
    }
    
    console.log('✅ Database connection successful!\n');
    
    // Check migration status
    console.log('2. Checking migration status...');
    const migrationStatus = await checkMigrationStatus();
    
    console.log(`   📊 Database events: ${migrationStatus.dbStats?.total_events || 0}`);
    console.log(`   📁 Cache files found: ${migrationStatus.cacheFileCount}`);
    
    if (migrationStatus.hasEvents) {
      console.log('✅ Database already contains events\n');
      
      const stats = await getDBStats();
      console.log('Current database stats:');
      console.log(`   - Total events: ${stats.total_events}`);
      console.log(`   - Years covered: ${stats.years_count} (${stats.earliest_year} - ${stats.latest_year})`);
      
    } else if (migrationStatus.cacheFileCount > 0) {
      console.log('📦 Found cache files that can be migrated\n');
      
      const migrate = await question('Would you like to migrate cache data to database? (y/N): ');
      
      if (migrate.toLowerCase() === 'y' || migrate.toLowerCase() === 'yes') {
        console.log('\n🔄 Starting migration...');
        await migrateFromCache();
        
        const finalStats = await getDBStats();
        console.log('\n✅ Migration completed!');
        console.log(`   - Migrated ${finalStats.total_events} events`);
        console.log(`   - Covering ${finalStats.years_count} years`);
      }
    } else {
      console.log('ℹ️  No existing cache data found');
      console.log('   The system will populate the database as it fetches new event data\n');
    }
    
    console.log('🎉 Setup completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Start your application: npm start');
    console.log('2. Visit /api/db-status to monitor database status');
    console.log('3. The search system will now use MariaDB for faster queries');
    
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  } finally {
    rl.close();
    process.exit(0);
  }
}

main();
