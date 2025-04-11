const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchTBAEventDetails} = require('../helpers/api');
const { processMatchDataWithTBAResults, calculateRecordFromCompletedMatches } = require('../helpers/matches');
// const apiRoutes = require('./api');

// GET /api/TBA-matches/test - Returns raw event data
// DO NOT UNCOMMENT THIS UNLESS YOU KNOW WHAT YOU'RE DOING AS THIS WILL ALLOW OTHERS TO EXPLOIT YOUR API KEY
// router.get('/test', async (req, res) => {
//   const { eventKey } = req.query;
//   const eventDetails = await fetchEventDetails(eventKey);
//   res.send(eventDetails);
// });
// router.use('/api', apiRoutes);

// GET / - Full page version with TBA data
router.get('/', async (req, res) => {
  const { teamKey, eventKey: rawEventKey } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;
  
  // If teamKey or eventKey are not provided, render an input form
  if (!teamKey || !eventKey) {
    return res.render('pages/home');
  }
  
  // Format team number (remove "frc" prefix if present)
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
  
  try {
    // Load match data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Fetch event name from TBA
    let eventName = eventKey; // Default to eventKey if TBA fetch fails
    try {
      const tbaEventDetails = await fetchTBAEventDetails(eventKey);
      if (tbaEventDetails && tbaEventDetails.name) {
        eventName = tbaEventDetails.name;
      }
    } catch (error) {
      console.error('Error fetching event name from TBA:', error);
    }
    
    // Fetch team ranking data from TBA
    const formattedTBATeamKey = `frc${formattedTeamKey}`;
    const teamStatus = await fetchTeamStatusAtEvent(formattedTBATeamKey, eventKey);
    
    // Extract ranking information
    let teamRanking = null;

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
      
      // Get matches played from TBA (fallback)
      const tbaMatchesPlayed = teamStatus.qual.ranking.matches_played || 0;
      
      // Rest of the existing code
      let matches = [...eventData.matches]; // Create a copy we can modify
      const nowQueuing = eventData.nowQueuing;
      
      // Sort matches by their sequence (match type then number)
      matches.sort((a, b) => {
        const aType = a.label.split(' ')[0];
        const bType = b.label.split(' ')[0];
        
        if (aType !== bType) return aType.localeCompare(bType);
        
        const aNum = parseInt(a.label.split(' ')[1]);
        const bNum = parseInt(b.label.split(' ')[1]);
        return aNum - bNum;
      });
      
      // Auto-complete logic: mark earlier "On field" match as "Completed" if a later one is "On field"
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
      
      // Filter matches for the requested team
      const teamMatches = matches.filter(match => 
        Array.isArray(match.redTeams) && match.redTeams.includes(formattedTeamKey) || 
        Array.isArray(match.blueTeams) && match.blueTeams.includes(formattedTeamKey)
      );
      
      // Count all completed matches for the team from Nexus data (including non-qualification matches)
      const completedMatches = teamMatches.filter(match => 
        match.status === "Completed"
      ).length;
      
      // Use Nexus data for matches played count if available, otherwise fall back to TBA
      const matchesPlayed = completedMatches > 0 ? completedMatches : tbaMatchesPlayed;
      
      teamRanking = {
        rank: teamStatus.qual.ranking.rank,
        totalRP: totalRP,
        matches: teamStatus.qual.num_teams,
        record: `${teamStatus.qual.ranking.record.wins}-${teamStatus.qual.ranking.record.losses}-${teamStatus.qual.ranking.record.ties}`,
        matchesPlayed: matchesPlayed
      };
    }
    
    // Rest of the existing code
    let matches = [...eventData.matches]; // Create a copy we can modify
    const nowQueuing = eventData.nowQueuing;
    
    // Sort matches by their sequence (match type then number)
    matches.sort((a, b) => {
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      
      if (aType !== bType) return aType.localeCompare(bType);
      
      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });
    
    // Auto-complete logic: mark earlier "On field" match as "Completed" if a later one is "On field"
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
    
    // Filter matches for the requested team
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

    // Calculate record from completed matches
    const nexusRecord = calculateRecordFromCompletedMatches(completedMatches);
    const nexusRecordString = `${nexusRecord.wins}-${nexusRecord.losses}-${nexusRecord.ties}`;

    // Use Nexus record instead of TBA record
    if (teamRanking) {
      teamRanking.record = nexusRecordString;
    }
    
    // Render the matches page with the match data and ranking info
    res.render('pages/matches', {
      teamKey,
      formattedTeamKey,
      eventKey,
      eventName,
      matchGroups,
      completedMatches,
      nowQueuing,
      teamRanking
    });
    
  } catch (error) {
    console.error('Error generating full page match data:', error);
    // Instead of returning error JSON, render the same page with empty data and error message
    res.render('pages/matches', {
      teamKey: teamKey || '',
      formattedTeamKey: teamKey ? (teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey) : '',
      eventKey: eventKey || '',
      eventName: eventKey || 'Unknown Event',
      matchGroups: {},
      completedMatches: [],
      nowQueuing: null,
      teamRanking: null,
      errorMessage: `Failed to generate match data: ${error.message}`
    });
  }
});

// GET /embed - Embeddable version of team match display
router.get('/embed', async (req, res) => {
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
  
  try {
    // Load match data
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Fetch event name from TBA
    let eventName = eventKey; // Default to eventKey if TBA fetch fails
    try {
      const tbaEventDetails = await fetchTBAEventDetails(eventKey);
      if (tbaEventDetails && tbaEventDetails.name) {
        eventName = tbaEventDetails.name;
      }
    } catch (error) {
      console.error('Error fetching event name from TBA:', error);
    }
    
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
      eventName: eventKey || 'Unknown Event',
      matchGroups: {},
      completedMatches: [],
      nowQueuing: null,
      containerHeight,
      teamRanking: null,
      errorMessage: `Failed to generate match data: ${error.message}`
    });
  }
});

// GET /preview - Social media preview page
router.get('/preview', async (req, res) => {
  const { teamKey, eventKey: rawEventKey } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;
  
  if (!teamKey || !eventKey) {
    return res.redirect('/');
  }
  
  // Check if the request is from a bot/crawler by examining user agent
  const userAgent = req.get('User-Agent') || '';
  const isBot = /bot|crawler|spider|facebook|twitter|slack|discord|telegram|whatsapp|linkedin|pinterest|preview/i.test(userAgent);
  
  // For normal browsers (not bots), redirect immediately to the main page
  if (!isBot) {
    return res.redirect(`/?teamKey=${teamKey}&eventKey=${eventKey}`);
  }
  
  try {
    // Continue with the existing code for bots to see the preview with OG tags
    const formattedTeamKey = teamKey.startsWith("frc") ? teamKey : `frc${teamKey}`;
    const teamNumber = formattedTeamKey.replace('frc', '');
    
    // Get event details
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).render('pages/404');
    }
    
    // Fetch event name from TBA for better display
    let eventName = eventKey;
    try {
      const tbaEventDetails = await fetchTBAEventDetails(eventKey);
      if (tbaEventDetails && tbaEventDetails.name) {
        eventName = tbaEventDetails.name;
      }
    } catch (error) {
      console.error('Error fetching event name from TBA:', error);
    }
    
    // Set Open Graph metadata
    const ogUrl = `https://vorel.app/?teamKey=${teamNumber}&eventKey=${eventKey}`;
    const ogTitle = `Team ${teamNumber} at ${eventName}`;
    const ogDescription = `View match schedule and results for FRC Team ${teamNumber} at ${eventName}`;
    const ogImage = 'https://vorel.app/banner-social2.png';
    
    // Render a page with proper OG tags
    res.render('pages/preview', {
      teamKey: teamNumber,
      eventKey,
      eventName,
      ogUrl,
      ogTitle, 
      ogDescription,
      ogImage,
      redirectUrl: `/?teamKey=${teamNumber}&eventKey=${eventKey}`
    });
    
  } catch (error) {
    console.error('Error generating preview:', error);
    res.status(500).render('pages/404');
  }
});

// Add a health endpoint for Docker healthchecks
router.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});



module.exports = router;