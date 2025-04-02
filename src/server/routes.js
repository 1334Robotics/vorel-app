const express = require('express');
const router = express.Router();
const { fetchEventDetails, fetchTeamStatusAtEvent, fetchEventMatchResults } = require('./api');
const crypto = require('crypto');

// GET /api/TBA-matches/test - Returns raw event data
router.get('/test', async (req, res) => {
  const { eventKey } = req.query;
  const eventDetails = await fetchEventDetails(eventKey);
  res.send(eventDetails);
});

// Function to process match data with TBA results
async function processMatchDataWithTBAResults(matches, teamKey, eventKey) {
  try {
      // Ensure teamKey is in the right format for TBA
      const formattedTeamKey = teamKey.startsWith('frc') ? teamKey : `frc${teamKey}`;

      // Fetch match results from TBA
      const tbaMatches = await fetchEventMatchResults(eventKey);

      // Create a map of TBA match results for quick lookup
      const tbaMatchMap = {};
      tbaMatches.forEach(match => {
          const matchKey = match.comp_level + match.match_number;
          tbaMatchMap[matchKey] = match;
      });

      matches.forEach(match => {
          if (match.status === "Completed") {
              const [type, numberStr] = match.label.split(' ');
              const number = parseInt(numberStr);
              let compLevel;
              switch(type.toLowerCase()) {
                  case 'qualification': compLevel = 'qm'; break;
                  case 'quarterfinal': compLevel = 'qf'; break;
                  case 'semifinal': compLevel = 'sf'; break;
                  case 'final': compLevel = 'f'; break;
                  case 'playoff': compLevel = 'pl'; break; // Add playoff type
                  case 'practice': compLevel = 'pr'; break; // Add practice type
                  default: compLevel = 'xx'; // Use a non-qm value as default
              }

              const matchKey = compLevel + number;
              const tbaMatch = tbaMatchMap[matchKey];

              // Only consider it a qualification match if it explicitly has "qualification" in the label
              const matchType = match.label.split(' ')[0].toLowerCase();
              const isQualificationMatch = matchType === 'qualification';

              if (tbaMatch && tbaMatch.alliances) {
                  const isRed = match.redTeams.includes(teamKey.replace('frc', ''));
                  const allianceColor = isRed ? 'red' : 'blue';
                  const opposingColor = isRed ? 'blue' : 'red';

                  const allianceScore = tbaMatch.alliances[allianceColor].score;
                  const opposingScore = tbaMatch.alliances[opposingColor].score;

                  if (tbaMatch.winning_alliance === allianceColor) {
                      match.result = 'win';
                  } else if (tbaMatch.winning_alliance === opposingColor) {
                      match.result = 'loss';
                  } else if (tbaMatch.winning_alliance === '') {
                      match.result = 'tie';
                  }

                  match.score = {
                      alliance: allianceScore,
                      opposing: opposingScore
                  };

                  // Only calculate ranking points for qualification matches
                  if (isQualificationMatch && tbaMatch.score_breakdown) {
                      const rpBreakdown = tbaMatch.score_breakdown[allianceColor];
                      
                      if (rpBreakdown) {
                          match.rankingPoints = {
                              total: 0,
                              breakdown: []
                          };
                          
                          // Adjust for REEFSCAPE ranking points
                          if (rpBreakdown.autoCoralScored >= 3) {
                              match.rankingPoints.breakdown.push('Autonomous RP');
                              match.rankingPoints.total += 1;
                          }

                          if (rpBreakdown.endGameBargePoints >= 15) {
                              match.rankingPoints.breakdown.push('Barge RP');
                              match.rankingPoints.total += 1;
                          }

                          if (match.result === 'win') {
                              match.rankingPoints.breakdown.push('Win');
                              match.rankingPoints.total += 3;
                          } else if (match.result === 'tie') {
                              match.rankingPoints.breakdown.push('Tie');
                              match.rankingPoints.total += 1;
                          }

                          if (rpBreakdown.coralScored >= 5) {
                              match.rankingPoints.breakdown.push('Coral RP');
                              match.rankingPoints.total += 1;
                          }

                          if (rpBreakdown.coopertitionBonus) {
                              match.rankingPoints.breakdown.push('Coopertition RP');
                              match.rankingPoints.total += 1;
                          }
                      }
                  }
              }
          }
      });

      return matches;
  } catch (error) {
      console.error('Error processing TBA match data:', error);
      return matches;
  }
}



// GET / - Full page version with TBA data
router.get('/', async (req, res) => {
  const { teamKey, eventKey } = req.query;
  
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
    
    // Render the matches page with the match data
    res.render('pages/matches', {
      teamKey,
      formattedTeamKey,
      eventKey,
      matchGroups,
      completedMatches,
      nowQueuing
    });
    
  } catch (error) {
    console.error('Error generating full page match data:', error);
    res.status(500).json({ error: 'Failed to generate match data' });
  }
});

// GET /embed - Embeddable version of team match display
router.get('/embed', async (req, res) => {
  const { teamKey, eventKey, height = '600' } = req.query;
  
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
    
    // Render the embed page with the match data
    res.render('pages/embed', {
      teamKey,
      formattedTeamKey,
      eventKey,
      matchGroups,
      completedMatches,
      nowQueuing,
      containerHeight
    });
    
  } catch (error) {
    console.error('Error generating match data:', error);
    res.status(500).json({ error: 'Failed to generate match data' });
  }
});

// Add a health endpoint for Docker healthchecks
router.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

// Add a data-check endpoint to detect changes
router.get('/api/data-check', async (req, res) => {
  let { eventKey, lastUpdate } = req.query;

  try {
    const eventData = await fetchEventDetails(eventKey);
    if (!eventData) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Create a copy of matches for modification
    const modifiedMatches = [...eventData.matches];

    // Sort matches by their sequence
    modifiedMatches.sort((a, b) => {
      const aType = a.label.split(' ')[0];
      const bType = b.label.split(' ')[0];
      if (aType !== bType) return aType.localeCompare(bType);

      const aNum = parseInt(a.label.split(' ')[1]);
      const bNum = parseInt(b.label.split(' ')[1]);
      return aNum - bNum;
    });

    // Mark earlier matches as completed if a later match is "On field"
    for (let i = 0; i < modifiedMatches.length - 1; i++) {
      if (modifiedMatches[i].status === "On field") {
        for (let j = i + 1; j < modifiedMatches.length; j++) {
          if (modifiedMatches[j].status === "On field") {
            modifiedMatches[i].status = "Completed";
            break;
          }
        }
      }
    }

    // Create a consistent hash of important data
    const dataHash = JSON.stringify({
      nowQueuing: eventData.nowQueuing || null,
      matchStatuses: modifiedMatches.map(m => ({
        id: m.label.replace(/\s+/g, '-'),
        status: m.status.trim()
      })).sort((a, b) => a.id.localeCompare(b.id))
    });

    const currentHash = crypto
      .createHash('md5')
      .update(dataHash)
      .digest('hex');

    // If lastUpdate is empty, assume it's the initial load and don't trigger a refresh
    if (!lastUpdate) {
      lastUpdate = currentHash;
    }

    const hasChanged = lastUpdate !== currentHash;

    res.json({
      changed: hasChanged,
      hash: currentHash,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error checking for data updates:', error);
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

module.exports = router;
