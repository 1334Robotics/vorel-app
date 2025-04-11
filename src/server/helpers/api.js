const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const Nexus_Api_Key = process.env.Nexus_Api_Key;
const TBA_API_Key = process.env.TBA_API_Key;
const BASE_URL = 'https://frc.nexus/api/v1/event';
const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';


// Path to the cache file - events will be stored by year
const CACHE_DIR = path.join(__dirname, '../../.cache');
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

// Function to fetch events from TBA and save to cache file
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
    
    // Format and save the events to the cache file
    const formattedEvents = events.map(event => {
      const startDate = new Date(event.start_date);
      const endDate = new Date(event.end_date);
      const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + 
                     (startDate.toDateString() !== endDate.toDateString() ? 
                      ` - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 
                      '');
      
      return {
        key: event.key,
        name: `${year} ${event.name}`, // Add year in front of event name
        city: event.city,
        state_prov: event.state_prov,
        country: event.country,
        location: `${event.city || ''}, ${event.state_prov || ''}`.replace(/(^, )|(, $)/g, ''),
        date: `${dateStr}, ${year}`,
        searchString: `${year} ${event.name} ${event.city || ''} ${event.state_prov || ''} ${event.country || ''} ${event.key}`.toLowerCase() // Also update search string
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    
    fs.writeFileSync(cachePath, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      events: formattedEvents
    }));
    
    console.log(`Cache updated with ${formattedEvents.length} events for ${year}`);
    return formattedEvents;
  } catch (error) {
    console.error(`Error updating events cache for ${year}:`, error.message);
    
    // Create an empty cache file if one doesn't exist yet
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

// Initialize cache at startup
function initializeEventCache() {
  const currentYear = new Date().getFullYear();
  // Initialize cache for current and next year
  updateEventsCache(currentYear).catch(err => console.error(`Failed to initialize cache for ${currentYear}:`, err.message));
  updateEventsCache(currentYear + 1).catch(err => console.error(`Failed to initialize cache for ${currentYear + 1}:`, err.message));
  
  // Set up hourly cache updates
  setInterval(() => {
    updateEventsCache(currentYear).catch(err => console.error(`Failed to update cache for ${currentYear}:`, err.message));
    updateEventsCache(currentYear + 1).catch(err => console.error(`Failed to update cache for ${currentYear + 1}:`, err.message));
  }, 60 * 60 * 1000); // Update every hour
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
