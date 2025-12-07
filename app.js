require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini AI library
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // Import node-fetch
const session = require('express-session');

const app = express();
const port = 3000;

// Middleware
app.use(express.static('public')); // Serve static files (HTML, CSS, JS)
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(bodyParser.json()); // Parse JSON bodies

// Session middleware
app.use(session({
  secret: process.env.GEMINI_API_KEY, // Use API key as session secret
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// OpenAI Configuration
console.log("Gemini API Key being used:", process.env.GEMINI_API_KEY); // Add this line

// Gemini Configuration
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Using Gemini 2.5 Flash model

// Read instructions from recipe_extraction_tool.md
const instructionsPath = path.join(__dirname, 'recipe_extraction_instructions.md');
let instructions = '';

try {
  instructions = fs.readFileSync(instructionsPath, 'utf8');
} catch (err) {
  console.error('Error reading instructions file:', err);
  instructions = 'Failed to load instructions.';
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Login endpoint
app.post('/login', (req, res) => {
  const { password } = req.body;

  if (password === process.env.APP_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true, message: 'Authentication successful' });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Logout endpoint
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logged out successfully' });
});

// Check auth status
app.get('/auth-status', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

app.post('/query-ai', requireAuth, async (req, res) => {
  const userQuery = req.body.query;
  let contentToProcess = userQuery; // Default to user's direct query

  // Check if the userQuery is a URL
  const urlRegex = /^(https?:\/\/[^\s$.?#].[^\s]*)$/i;
  if (urlRegex.test(userQuery)) {
    console.log(`Attempting to fetch content from URL: ${userQuery}`);
    try {
      const response = await fetch(userQuery);
      if (!response.ok) {
        throw new Error(`Failed to fetch URL: ${response.statusText} (${response.status})`);
      }
      contentToProcess = await response.text();
      console.log('Successfully fetched content from URL.');
    } catch (fetchError) {
      console.error('Error fetching URL content:', fetchError);
      return res.status(500).json({
        error: 'Failed to retrieve content from the provided URL. Please ensure it is a valid and accessible URL.',
        details: fetchError.message
      });
    }
  }

  if (!userQuery) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const prompt = `${instructions}\n\nHere is the recipe text to analyze:\n\n${contentToProcess}`;
    console.log('Sending request to Gemini with processed content...');

    // Use streaming to handle potentially large responses and avoid network errors
    const result = await model.generateContentStream(prompt);

    let rawText = '';
    for await (const chunk of result.stream) {
      rawText += chunk.text();
    }

    console.log('Response received from Gemini');
    
    // Extract JSON from the markdown code block and the remaining text from Gemini's response
    const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
    const jsonMatch = rawText.match(jsonRegex);

    let jsonResponse = null;
    let textResponse = rawText;

    if (jsonMatch && jsonMatch[1]) {
      try {
        jsonResponse = JSON.parse(jsonMatch[1]);
        textResponse = rawText.replace(jsonRegex, '').trim();
      } catch (parseError) {
        console.error('Error parsing JSON from Gemini response:', parseError);
        // If JSON parsing fails, just return the raw text
        textResponse = rawText;
      }
    }

    res.json({ response: textResponse, recipeJson: jsonResponse });
  } catch (error) {
    // Log the full error to the console for debugging
    console.error('Detailed error querying Gemini:', error);

    // Send a more informative error message to the user
    res.status(500).json({
      error: 'Error processing your query with Gemini',
      details: error.message
    });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
