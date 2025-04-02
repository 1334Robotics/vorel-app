const axios = require('axios');
require('dotenv').config();

const Nexus_Api_Key = process.env.Nexus_Api_Key;
const TBA_API_Key = process.env.TBA_API_Key;
const BASE_URL = 'https://frc.nexus/api/v1/event';
const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';

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

module.exports = {
  fetchEventDetails,
  fetchTeamStatusAtEvent,
  fetchEventMatchResults
};
