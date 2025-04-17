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

// Update fetchEventDetails to map TBA event keys to Nexus event keys
async function fetchEventDetails(eventKey) {
  const nexusEventKey = mapEventKey(eventKey, 'tba', 'nexus');
  const url = `${BASE_URL}/${nexusEventKey}`;
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
  const tbaEventKey = mapEventKey(eventKey, 'nexus', 'tba');
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey : `frc${teamKey}`;
  const url = `${TBA_BASE_URL}/team/${formattedTeamKey}/event/${tbaEventKey}/status`;
  
  const response = await axios.get(url, {
    headers: {
      'X-TBA-Auth-Key': TBA_API_Key
    }
  });
  
  return response.data;
}

// Fetch all match results for an event from TBA
async function fetchEventMatchResults(eventKey) {
  const tbaEventKey = mapEventKey(eventKey, 'nexus', 'tba');
  const url = `${TBA_BASE_URL}/event/${tbaEventKey}/matches`;
  
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

// Modified function to search across all cached years
async function searchTBAEvents(query, preferredYear = new Date().getFullYear()) {
  try {
    // If no query, return empty results
    if (!query || query.length === 0) {
      return [];
    }
    
    const queryLower = query.toLowerCase();
    
    // Read all cache files in the directory
    const files = fs.readdirSync(CACHE_DIR);
    const cacheFiles = files.filter(file => file.match(/tba-events-(\d{4})\.json/));
    
    // If no cache files found, fall back to API for preferred year
    if (cacheFiles.length === 0) {
      console.log('No cache files found, falling back to direct API call');
      return fallbackSearchTBAEvents(query, preferredYear);
    }
    
    // Collect events from all cache files
    let allEvents = [];
    let preferredYearEvents = [];
    
    for (const file of cacheFiles) {
      const match = file.match(/tba-events-(\d{4})\.json/);
      if (match) {
        const year = parseInt(match[1]);
        const cachePath = getEventCachePath(year);
        
        // Check if we need to update this cache file
        let events;
        const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        
        // Update cache if we're looking at the preferred year and it's outdated
        // We only check the preferred year to avoid excessive updates
        if (year === preferredYear) {
          const lastUpdated = new Date(cacheData.lastUpdated);
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
          
          if (lastUpdated <= oneHourAgo) {
            // Cache for preferred year is outdated, update it
            try {
              events = await updateEventsCache(year);
              preferredYearEvents = events;
            } catch (error) {
              console.error(`Error updating cache for ${year}:`, error.message);
              events = cacheData.events;
            }
          } else {
            events = cacheData.events;
            preferredYearEvents = events;
          }
        } else {
          // For other years, just use the cache as-is
          events = cacheData.events;
        }
        
        // Add events to our collection
        allEvents = [...allEvents, ...events];
      }
    }
    
    // First search in the preferred year
    const preferredResults = preferredYearEvents.filter(event => 
      event.searchString.includes(queryLower)
    );
    
    // Then search in all years
    const otherResults = allEvents.filter(event => 
      event.searchString.includes(queryLower) && 
      !preferredResults.some(pe => pe.key === event.key)
    );
    
    // Return preferred year results first, then other matching results
    return [...preferredResults, ...otherResults];
    
  } catch (error) {
    console.error(`Error searching events from cache:`, error.message);
    // Fallback to direct API call for the preferred year if cache fails
    console.log('Falling back to direct TBA API call');
    return fallbackSearchTBAEvents(query, preferredYear);
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

// Add this function to map between TBA and Nexus event keys
function mapEventKey(eventKey, sourceSystem, targetSystem) {
  // Championship division mapping between TBA and Nexus
  const tbaToNexusMap = {
    // 2025 Championship divisions
    '2025arc': '2025archimedes', // Archimedes Division
    '2025cur': '2025curie',  // Curie Division
    '2025gal': '2025galileo',  // Galileo Division
    '2025hop': '2025hopper',  // Hopper Division
    '2025joh': '2025johnson',  // Johnson Division
    '2025mil': '2025milstein',  // Milstein Division
    '2025new': '2025newton',  // Newton Division
    '2025dal': '2025daly',  // Daly Division
  };
  
  const nexusToTbaMap = {};
  // Create reverse mapping
  Object.entries(tbaToNexusMap).forEach(([tba, nexus]) => {
    nexusToTbaMap[nexus] = tba;
  });
  
  if (sourceSystem === 'tba' && targetSystem === 'nexus') {
    return tbaToNexusMap[eventKey] || eventKey;
  } else if (sourceSystem === 'nexus' && targetSystem === 'tba') {
    return nexusToTbaMap[eventKey] || eventKey;
  }
  
  // If no mapping or unknown source/target, return the original key
  return eventKey;
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
    const yearsToSkip = new Set();
    
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
    
    // Check existing cache files
    cacheFiles.forEach(file => {
      const match = file.match(/tba-events-(\d{4})\.json/);
      if (match) {
        const year = parseInt(match[1]);
        
        // Skip if it's current or next year (already handled above)
        if (year === currentYear || year === currentYear + 1) {
          return;
        }
        
        // Skip ALL years before 2025, regardless of recency
        if (year < 2025) {
          yearsToSkip.add(year);
          return;
        }
        
        // Check if year is too old (more than 2 years before current year)
        if (year < currentYear - 2) {
          yearsToSkip.add(year);
          return;
        }
        
        // For years 2025+ that are recent enough, do daily updates
        const lastUpdate = lastUpdateTimes.get(year) || 0;
        const dailyThreshold = now - (24 * 60 * 60 * 1000); // 24 hours ago
        
        if (lastUpdate <= dailyThreshold) {
          yearsToUpdate.add(year);
          // Schedule next update
          const nextUpdate = new Date(now + (24 * 60 * 60 * 1000));
          nextScheduledUpdates.set(year, nextUpdate);
        }
      }
    });
    
    // Check for missing cache files ONLY for years 2025+ and current/next
    // This prevents creating cache for pre-2025 years
    for (let year = Math.max(2025, currentYear - 2); year <= currentYear + 1; year++) {
      const cachePath = getEventCachePath(year);
      if (!fs.existsSync(cachePath)) {
        yearsToUpdate.add(year);
        console.log(`Creating initial cache for ${year}`);
      }
    }
    
    // Log update schedule for all years
    const allYears = new Set([...yearsToUpdate, ...lastUpdateTimes.keys()]);
    allYears.forEach(year => {
      if (yearsToSkip.has(year)) {
        console.log(`Year ${year}: Skipping updates (more than 2 years old)`);
      } else {
        const nextUpdate = nextScheduledUpdates.get(year);
        if (nextUpdate) {
          console.log(`Year ${year}: Next update scheduled for ${nextUpdate.toLocaleString()}`);
        }
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
            console.log(`Updated cache for ${year}, next update at ${nextScheduledUpdates.get(year)?.toLocaleString() || 'never'}`);
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
