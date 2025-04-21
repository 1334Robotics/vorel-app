const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchTBAEventDetails} = require('../helpers/api');
const { processMatchDataWithTBAResults } = require('../helpers/matches');
const { getParentDomains } = require('../helpers/twitch');

router.get('/', async (req, res) => {
    res.status(200).json({ message: 'Embed endpoint is online but it seems that you haven\'t defined which one!' });
})



// GET /embed/matches - Embeddable version of team match display
router.get('/matches', async (req, res) => {
  const { teamKey, eventKey: rawEventKey, height = '600' } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;
  
  if (!teamKey) {
    return res.status(400).json({ error: 'Missing teamKey parameter' });
  }

  if (!eventKey) {
    return res.status(400).json({ error: 'Missing eventKey parameter' });
  }
  
  // Format team number (remove "frc" prefix if present)
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
  
  // Set display options
  const containerHeight = parseInt(height) > 0 ? parseInt(height) : 600;
  
  // Fetch event name from TBA before main data retrieval
  let eventName = eventKey; // Default to eventKey if TBA fetch fails
  try {
    const tbaEventDetails = await fetchTBAEventDetails(eventKey);
    if (tbaEventDetails && tbaEventDetails.name) {
      eventName = tbaEventDetails.name;
    }
  } catch (error) {
    console.error('Error fetching event name from TBA:', error);
  }
  
  try {
    // Load match data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // We already fetched the event name above, no need to fetch it again
    
    // Fetch team ranking data from TBA
    const formattedTBATeamKey = `frc${formattedTeamKey}`;
    const teamStatus = await fetchTeamStatusAtEvent(formattedTBATeamKey, eventKey);
    
    // Extract ranking information
    let teamRanking = null;
    let totalRankingPoints = 0;

    if (teamStatus && teamStatus.qual && teamStatus.qual.ranking) {
      
      // For 2025 REEFSCAPE, we need to calculate the total RP correctly
      // First, check if ranking_points is directly available
      let totalRP = 0;
      
      if (teamStatus.qual.ranking.ranking_points !== undefined) {
        // If TBA provides ranking_points directly
        totalRP = teamStatus.qual.ranking.ranking_points;
      } else if (teamStatus.qual.ranking.extra_stats && teamStatus.qual.ranking.extra_stats.length > 0) {
        // Try extra_stats (sometimes TBA puts RP here)
        totalRP = teamStatus.qual.ranking.extra_stats[0] || 0;
      } else if (teamStatus.qual.ranking.sort_orders && teamStatus.qual.ranking.sort_orders.length > 0) {
        // Try sort_orders (another place TBA may put RP)
        totalRP = teamStatus.qual.ranking.sort_orders[0] || 0;
      }
      
      // Get matches played
      const matchesPlayed = teamStatus.qual.ranking.matches_played || 0;
      
      teamRanking = {
        rank: teamStatus.qual.ranking.rank,
        totalRP: totalRP,
        matches: teamStatus.qual.num_teams,
        record: `${teamStatus.qual.ranking.record.wins}-${teamStatus.qual.ranking.record.losses}-${teamStatus.qual.ranking.record.ties}`,
        matchesPlayed: matchesPlayed
      };
      
      totalRankingPoints = totalRP;
    }
    
    // Use these variables from the fetched data
    let matches = [...eventData.matches]; // Create a copy we can modify
    const nowQueuing = eventData.nowQueuing;
    
    // First, sort matches by their sequence
    matches.sort((a, b) => {
      // First sort by match type (Qualification, Playoff, etc.)
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      
      if (aType !== bType) return aType.localeCompare(bType);
      
      // Then sort by match number
      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });
    
    // Apply the same auto-completion logic
    for (let i = 0; i < matches.length - 1; i++) {
      if (matches[i].status === "On field") {
        for (let j = i + 1; j < matches.length; j++) {
          if (matches[j].status === "On field") {
            matches[i].status = "Completed";
            break;
          }
        }
      }
    }
    
    // Filter matches for the requested team using the modified matches
    const teamMatches = matches.filter(match => 
      Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
      Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
    );
    
    // Add TBA data to matches
    const matchesWithResults = await processMatchDataWithTBAResults(teamMatches, formattedTeamKey, eventKey);
    
    // Group matches by type and separate completed matches
    const matchGroups = {};
    const completedMatches = []; 
    matchesWithResults.forEach(match => {
      if (match.status === "Completed") {
        completedMatches.push(match);
      } else {
        const matchType = match.label.split(' ')[0];
        if (!matchGroups[matchType]) {
          matchGroups[matchType] = [];
        }
        matchGroups[matchType].push(match);
      }
    });
    
    // Render the embed page with the match data and ranking info
    res.render('pages/embed', {
      teamKey,
      formattedTeamKey,
      eventKey,
      eventName,
      matchGroups,
      completedMatches,
      nowQueuing,
      containerHeight,
      teamRanking
    });
    
  } catch (error) {
    console.error('Error generating match data:', error);
    // Instead of returning error JSON, render the embed page with empty data and error message
    res.render('pages/embed', {
      teamKey,
      formattedTeamKey,
      eventKey,
      eventName, // Use the already fetched event name instead of falling back to eventKey
      matchGroups: {},
      completedMatches: [],
      nowQueuing: null,
      containerHeight,
      teamRanking: null,
      errorMessage: `Failed to generate match data: ${error.message}`
    });
  }
});

// GET /embed/stream - Embeddable Twitch stream for an event
router.get('/stream', async (req, res) => {
  const { eventKey: rawEventKey, height = '480' } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;

  if (!eventKey) {
    return res.status(400).json({ error: 'Missing eventKey parameter' });
  }

  try {
    // Fetch event details from TBA
    const tbaEvent = await fetchTBAEventDetails(eventKey);
    if (!tbaEvent) {
      return res.status(404).render('pages/404');
    }

    // Parse event dates
    const today = new Date();
    const startDate = new Date(tbaEvent.start_date);
    const endDate = new Date(tbaEvent.end_date);
    endDate.setHours(23, 59, 59, 999); // Include the whole last day

    // Find Twitch stream(s) from webcasts
    let twitchChannel = null;
    if (Array.isArray(tbaEvent.webcasts)) {
      const twitchWebcast = tbaEvent.webcasts.find(wc => wc.type === 'twitch' && wc.channel);
      if (twitchWebcast) {
        twitchChannel = twitchWebcast.channel;
      }
    }

    let streamStatus = '';
    if (today < startDate) {
      streamStatus = 'not_started';
    } else if (today > endDate) {
      streamStatus = 'ended';
    } else {
      streamStatus = twitchChannel ? 'live' : 'no_stream';
    }

    res.render('pages/stream', {
      eventKey,
      eventName: tbaEvent.name,
      twitchChannel,
      streamStatus,
      containerHeight: parseInt(height) > 0 ? parseInt(height) : 480,
      startDate,
      endDate,
      parentDomains: getParentDomains(req),
    });
  } catch (error) {
    console.error('Error generating stream embed:', error);
    res.status(500).render('pages/404');
  }
});

module.exports = router;