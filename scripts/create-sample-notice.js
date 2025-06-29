#!/usr/bin/env node

/**
 * Script to create a sample notice in the database
 * This is a one-time script to test the notice functionality
 */

require('dotenv').config();
const { createNotice, initializeDB } = require('../src/server/helpers/database');

async function createSampleNotice() {
  console.log('Initializing database connection...');
  
  const dbInitialized = await initializeDB();
  if (!dbInitialized) {
    console.error('Failed to initialize database connection');
    process.exit(1);
  }

  console.log('Creating sample notice...');
  
  try {
    const noticeData = {
      title: '🚀 API Update',
      content: 'Vorel has received an API update to improve the live event data. If you encounter any issues while using the app, please report them to our <a href="https://github.com/1334Robotics/vorel-app/issues" target="_blank" rel="noopener">GitHub Issues</a> page.',
      type: 'info',
      is_active: true,
      priority: 10
    };

    const noticeId = await createNotice(noticeData);
    console.log(`✅ Successfully created notice with ID: ${noticeId}`);
    
    // Create another sample notice
    const noticeData2 = {
      title: '⚠️ Maintenance Notice',
      content: 'The site will undergo maintenance from 2:00 AM to 4:00 AM EST tomorrow. Some features may be temporarily unavailable.',
      type: 'warning',
      is_active: true,
      priority: 5,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // Expires in 7 days
    };

    const noticeId2 = await createNotice(noticeData2);
    console.log(`✅ Successfully created notice with ID: ${noticeId2}`);
    
  } catch (error) {
    console.error('❌ Error creating sample notice:', error.message);
    process.exit(1);
  }

  console.log('✅ Sample notices created successfully!');
  process.exit(0);
}

// Run the script
createSampleNotice().catch(error => {
  console.error('❌ Script failed:', error);
  process.exit(1);
});
