const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchTBAEventDetails} = require('../helpers/api');
const { processMatchDataWithTBAResults, calculateRecordFromCompletedMatches } = require('../helpers/matches');
const { getActiveNotices } = require('../helpers/database');
// const apiRoutes = require('./api');

// GET /test - Returns raw event data
// DO NOT UNCOMMENT THIS UNLESS YOU KNOW WHAT YOU'RE DOING AS THIS WILL ALLOW OTHERS TO EXPLOIT YOUR API KEY
// router.get('/test', async (req, res) => {
//   const { eventKey } = req.query;
//   const eventDetails = await fetchEventDetails(eventKey);
//   res.send(eventDetails);
// });

// GET / - Full page version with TBA data
router.get('/', async (req, res) => {
  const { teamKey, eventKey: rawEventKey } = req.query;
  const eventKey = rawEventKey ? rawEventKey.toLowerCase() : rawEventKey;
  
  // If teamKey or eventKey are not provided, render an input form
  if (!teamKey || !eventKey) {
    try {
      // Fetch active notices from database
      const notices = await getActiveNotices();
      return res.render('pages/home', { notices });
    } catch (error) {
      console.error('Error fetching notices:', error);
      // Fallback to home page without notices if database error
      return res.render('pages/home', { notices: [] });
    }
  }
  
  // Format team number (remove "frc" prefix if present)
  const formattedTeamKey = teamKey.startsWith('frc') ? teamKey.substring(3) : teamKey;
  
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
    // Load match data, with temporary handling if the event is over
    let eventData;
    try {
      eventData = await fetchEventDetails(eventKey);
      if (!eventData) {
        // Event not found in Nexus
        return res.render('pages/matches', {
          teamKey: teamKey || '',
          formattedTeamKey,
          eventKey: eventKey || '',
          eventName,
          matchGroups: {},
          completedMatches: [],
          nowQueuing: null,
          teamRanking: null,
          errorMessage: `This event appears to be over or there has been an error. If the event is finished we are working on fixing it. If the event is not, please fill out a issue on our github. ${error.message}`
        });
      }
    } catch (error) {
      // Notify user if event is likely over, otherwise propagate error
      if (error.message.includes('404') || error.message.toLowerCase().includes('not found')) {
        return res.render('pages/matches', {
          teamKey: teamKey || '',
          formattedTeamKey,
          eventKey: eventKey || '',
          eventName,
          matchGroups: {},
          completedMatches: [],
          nowQueuing: null,
          teamRanking: null,
          errorMessage: `This event appears to be over or there has been an error. If the event is finished we are working on fixing it. If the event is not, please fill out a issue on our github. ${error.message}`
        });
      }
      // Other errors: rethrow to outer catch
      throw error;
    }
    
    // We already fetched the event name above, no need to fetch it again
    
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
    const processedData = await processMatchDataWithTBAResults(teamMatches, formattedTeamKey, eventKey);
    
    // Group matches by type and separate completed matches
    const matchGroups = {};
    const completedMatches = [];
    processedData.matches.forEach(match => {
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
      eventName, // Use the already fetched event name
      matchGroups: {},
      completedMatches: [],
      nowQueuing: null,
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
    const ogImage = 'https://vorel.app/banner-social3.avif';
    
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

// Add this route for the changelog page
router.get('/changelog', async (req, res) => {
  try {
    const { getChangelogData, getFallbackChangelog } = require('../helpers/changelog');
    let changelogData = await getChangelogData();
    
    // If no data, use fallback
    if (!changelogData || changelogData.length === 0) {
      changelogData = getFallbackChangelog();
    }
    
    res.render('pages/changelog', { changelogData });
  } catch (error) {
    console.error('Error loading changelog:', error);
    const { getFallbackChangelog } = require('../helpers/changelog');
    res.render('pages/changelog', { changelogData: getFallbackChangelog() });
  }
});


module.exports = router;