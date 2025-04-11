const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const Nexus_Api_Key = process.env.Nexus_Api_Key;
const TBA_API_Key = process.env.TBA_API_Key;
const BASE_URL = 'https://frc.nexus/api/v1/event';
const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';


// Path to the cache file - events will be stored by year
const CACHE_DIR = path.join(__dirname, '../../../.cache');
const getEventCachePath = (year) => path.join(CACHE_DIR, `tba-events-${year}.json`);

// Make sure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Add this new function to fetch event details
async function fetchEventDetails(eventKey) {
  const url = `${BASE_URL}/${eventKey}`;
  const response = await fetch(url, {
    headers: {
      'Nexus-Api-Key': Nexus_Api_Key
    }
  });
  
  if (!response.ok) {
    throw new Error(`Error fetching event details: ${response.statusText}`);
  }
  
  return response.json();
}

// Fetch team status at event (ranking info) from TBA
async function fetchTeamStatusAtEvent(teamKey, eventKey) {
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey : `frc${teamKey}`;
  const url = `${TBA_BASE_URL}/team/${formattedTeamKey}/event/${eventKey}/status`;
  
  const response = await axios.get(url, {
    headers: {
      'X-TBA-Auth-Key': TBA_API_Key
    }
  });
  
  return response.data;
}

// Fetch all match results for an event from TBA
async function fetchEventMatchResults(eventKey) {
  const url = `${TBA_BASE_URL}/event/${eventKey}/matches`;
  
  const response = await axios.get(url, {
    headers: {
      'X-TBA-Auth-Key': TBA_API_Key
    }
  });
  
  return response.data;
}

// Add this new function to fetch event name from TBA
async function fetchTBAEventDetails(eventKey) {
  const url = `${TBA_BASE_URL}/event/${eventKey}`;
  
  const response = await axios.get(url, {
    headers: {
      'X-TBA-Auth-Key': TBA_API_Key
    }
  });
  
  return response.data;
}

// Modify the updateEventsCache function to use a temporary file first
async function updateEventsCache(year = new Date().getFullYear()) {
  try {
    console.log(`Updating TBA events cache for ${year}...`);
    const url = `${TBA_BASE_URL}/events/${year}`;
    
    const response = await axios.get(url, {
      headers: {
        'X-TBA-Auth-Key': TBA_API_Key
      }
    });
    
    const events = response.data;
    const cachePath = getEventCachePath(year);
    const tempCachePath = `${cachePath}.tmp`;
    
    // Format events as before
    const formattedEvents = events.map(event => {
      const startDate = new Date(event.start_date);
      const endDate = new Date(event.end_date);
      const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + 
                     (startDate.toDateString() !== endDate.toDateString() ? 
                      ` - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 
                      '');
      
      return {
        key: event.key,
        name: `${year} ${event.name}`,
        city: event.city,
        state_prov: event.state_prov,
        country: event.country,
        location: `${event.city || ''}, ${event.state_prov || ''}`.replace(/(^, )|(, $)/g, ''),
        date: `${dateStr}, ${year}`,
        searchString: `${year} ${event.name} ${event.city || ''} ${event.state_prov || ''} ${event.country || ''} ${event.key}`.toLowerCase()
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    
    // Write to temporary file first
    fs.writeFileSync(tempCachePath, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      events: formattedEvents
    }));
    
    // Now atomically replace the old cache with the new one
    fs.renameSync(tempCachePath, cachePath);
    
    console.log(`Cache updated with ${formattedEvents.length} events for ${year}`);
    return formattedEvents;
  } catch (error) {
    console.error(`Error updating events cache for ${year}:`, error.message);
    
    // Only create an empty cache file if one doesn't exist at all
    const cachePath = getEventCachePath(year);
    if (!fs.existsSync(cachePath)) {
      fs.writeFileSync(cachePath, JSON.stringify({
        lastUpdated: new Date().toISOString(),
        events: []
      }));
      console.log(`Created empty cache file for ${year}`);
    }
    
    throw error;
  }
}

// Modified function to read from cached JSON file
async function searchTBAEvents(query, year = new Date().getFullYear()) {
  const cachePath = getEventCachePath(year);
  
  try {
    // Check if cache file exists and is less than 1 hour old
    let events;
    
    if (fs.existsSync(cachePath)) {
      const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      if (lastUpdated > oneHourAgo) {
        // Cache is still valid
        events = cacheData.events;
      } else {
        // Cache is outdated, update it
        events = await updateEventsCache(year);
      }
    } else {
      // Cache doesn't exist, create it
      events = await updateEventsCache(year);
    }
    
    // Filter events based on the search query
    if (!query || query.length === 0) {
      return [];
    }
    
    const queryLower = query.toLowerCase();
    return events.filter(event => 
      event.searchString.includes(queryLower)
    );
  } catch (error) {
    console.error(`Error searching events from cache for ${year}:`, error.message);
    // Fallback to direct API call if cache fails
    console.log('Falling back to direct TBA API call');
    return fallbackSearchTBAEvents(query, year);
  }
}

// Fallback to original implementation if cache fails
async function fallbackSearchTBAEvents(query, year) {
  const url = `${TBA_BASE_URL}/events/${year}`;
  
  const response = await axios.get(url, {
    headers: {
      'X-TBA-Auth-Key': TBA_API_Key
    }
  });
  
  // Filter events based on the search query
  const events = response.data;
  const filteredEvents = events.filter(event => {
    const searchString = `${event.name} ${event.city} ${event.state_prov} ${event.country} ${event.key}`.toLowerCase();
    return searchString.includes(query.toLowerCase());
  });
  
  // Format the results for the frontend (same as original function)
  return filteredEvents.map(event => {
    const startDate = new Date(event.start_date);
    const endDate = new Date(event.end_date);
    const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + 
                   (startDate.toDateString() !== endDate.toDateString() ? 
                    ` - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 
                    '');
    
    return {
      key: event.key,
      name: `${year} ${event.name}`, // Add year in front of event name
      location: `${event.city}, ${event.state_prov}`,
      date: `${dateStr}, ${year}`
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Add a Map to track the last update time for each year
const lastUpdateTimes = new Map();
const nextScheduledUpdates = new Map();

// Replace the manageEventCache function with this enhanced version
function manageEventCache() {
  console.log('Managing event cache...');
  const currentYear = new Date().getFullYear();
  const now = Date.now();
  
  // Read directory to find all cache files
  fs.readdir(CACHE_DIR, (err, files) => {
    if (err) {
      console.error('Error reading cache directory:', err);
      return;
    }
    
    // Get all existing event cache files
    const cacheFiles = files.filter(file => {
      return file.match(/tba-events-(\d{4})\.json/);
    });
    
    // Find years that need updates based on their update frequency
    const yearsToUpdate = new Set();
    
    // Check current and next year (hourly updates)
    const hourlyThreshold = now - (60 * 60 * 1000); // 1 hour ago
    [currentYear, currentYear + 1].forEach(year => {
      const lastUpdate = lastUpdateTimes.get(year) || 0;
      if (lastUpdate <= hourlyThreshold) {
        yearsToUpdate.add(year);
        // Schedule next update
        const nextUpdate = new Date(now + (60 * 60 * 1000));
        nextScheduledUpdates.set(year, nextUpdate);
      }
    });
    
    // Check years 2025+ (daily updates)
    const dailyThreshold = now - (24 * 60 * 60 * 1000); // 24 hours ago
    cacheFiles.forEach(file => {
      const match = file.match(/tba-events-(\d{4})\.json/);
      if (match) {
        const year = parseInt(match[1]);
        if (year >= 2025 && year !== currentYear && year !== currentYear + 1) {
          const lastUpdate = lastUpdateTimes.get(year) || 0;
          if (lastUpdate <= dailyThreshold) {
            yearsToUpdate.add(year);
            // Schedule next update
            const nextUpdate = new Date(now + (24 * 60 * 60 * 1000));
            nextScheduledUpdates.set(year, nextUpdate);
          }
        }
      }
    });
    
    // Log update schedule for all years
    const allYears = new Set([...yearsToUpdate, ...lastUpdateTimes.keys()]);
    allYears.forEach(year => {
      const nextUpdate = nextScheduledUpdates.get(year);
      if (nextUpdate) {
        console.log(`Year ${year}: Next update scheduled for ${nextUpdate.toLocaleString()}`);
      }
    });
    
    // Update years that need updating
    if (yearsToUpdate.size > 0) {
      console.log(`Updating cache for years: ${[...yearsToUpdate].join(', ')}`);
      yearsToUpdate.forEach(year => {
        updateEventsCache(year)
          .then(() => {
            // Record this update time
            lastUpdateTimes.set(year, now);
            console.log(`Updated cache for ${year}, next update at ${nextScheduledUpdates.get(year).toLocaleString()}`);
          })
          .catch(err => console.error(`Failed to update cache for ${year}:`, err.message));
      });
    } else {
      console.log('No cache updates needed at this time');
    }
  });
}

// Modify the initializeEventCache function for the improved behavior
function initializeEventCache() {
  // Initial cache management
  manageEventCache();
  
  // Set up hourly checks
  setInterval(() => {
    manageEventCache();
  }, 60 * 60 * 1000); // Check every hour
}

// Run initialization when module is loaded
initializeEventCache();

module.exports = {
  fetchEventDetails,
  fetchTeamStatusAtEvent,
  fetchEventMatchResults,
  fetchTBAEventDetails,
  searchTBAEvents,
  updateEventsCache, // Export this function for manual updates if needed
};
