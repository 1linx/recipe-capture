require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini AI library
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // Import node-fetch
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = 3000;

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;

// Only initialize Supabase if credentials are provided
if (supabaseUrl && supabaseKey && supabaseUrl !== 'your_supabase_project_url') {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('Supabase initialized successfully');
} else {
  console.log('Supabase not configured - recipe saving will be disabled');
}

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

// Public landing page - shows all recipes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Public recipe detail page
app.get('/recipes/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'recipe.html'));
});

// Protected import tool
app.get('/import', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'import.html'));
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

// Recipe API Endpoints

// Save a recipe to Supabase
app.post('/api/recipes', requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const recipeData = req.body;

    // Define allowed fields in the database schema
    const allowedFields = [
      'name', 'source', 'source_link', 'prep_time', 'cook_time', 'total_time',
      'rise_time', 'cooling_time', 'bake_time', 'servings', 'yield',
      'oven_temp', 'tin_size', 'dietary_info', 'ingredients', 'method',
      'tips', 'notes', 'storage', 'equipment', 'variations', 'make_ahead'
    ];

    // Filter recipe data to only include allowed fields
    const cleanRecipeData = {};
    for (const field of allowedFields) {
      if (recipeData[field] !== undefined) {
        cleanRecipeData[field] = recipeData[field];
      }
    }

    // Add metadata
    const recipeToSave = {
      ...cleanRecipeData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('recipes')
      .insert([recipeToSave])
      .select();

    if (error) throw error;

    res.json({ success: true, recipe: data[0] });
  } catch (error) {
    console.error('Error saving recipe:', error);
    res.status(500).json({
      error: 'Failed to save recipe',
      details: error.message
    });
  }
});

// Get all recipes (PUBLIC - no auth required)
app.get('/api/recipes', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { data, error } = await supabase
      .from('recipes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ recipes: data });
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({
      error: 'Failed to fetch recipes',
      details: error.message
    });
  }
});

// Get a single recipe by ID (PUBLIC - no auth required)
app.get('/api/recipes/:id', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { data, error } = await supabase
      .from('recipes')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    res.json({ recipe: data });
  } catch (error) {
    console.error('Error fetching recipe:', error);
    res.status(500).json({
      error: 'Failed to fetch recipe',
      details: error.message
    });
  }
});

// Update a recipe
app.put('/api/recipes/:id', requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const recipeData = req.body;

    // Define allowed fields in the database schema
    const allowedFields = [
      'name', 'source', 'source_link', 'prep_time', 'cook_time', 'total_time',
      'rise_time', 'cooling_time', 'bake_time', 'servings', 'yield',
      'oven_temp', 'tin_size', 'dietary_info', 'ingredients', 'method',
      'tips', 'notes', 'storage', 'equipment', 'variations', 'make_ahead'
    ];

    // Filter recipe data to only include allowed fields
    const cleanRecipeData = {};
    for (const field of allowedFields) {
      if (recipeData[field] !== undefined) {
        cleanRecipeData[field] = recipeData[field];
      }
    }

    const recipeToUpdate = {
      ...cleanRecipeData,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('recipes')
      .update(recipeToUpdate)
      .eq('id', req.params.id)
      .select();

    if (error) throw error;

    res.json({ success: true, recipe: data[0] });
  } catch (error) {
    console.error('Error updating recipe:', error);
    res.status(500).json({
      error: 'Failed to update recipe',
      details: error.message
    });
  }
});

// Delete a recipe
app.delete('/api/recipes/:id', requireAuth, async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { error } = await supabase
      .from('recipes')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    res.json({ success: true, message: 'Recipe deleted' });
  } catch (error) {
    console.error('Error deleting recipe:', error);
    res.status(500).json({
      error: 'Failed to delete recipe',
      details: error.message
    });
  }
});

app.post('/query-ai', requireAuth, async (req, res) => {
  const userQuery = req.body.query;

  if (!userQuery) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // Check if the input is already valid JSON
  let trimmedQuery = userQuery.trim();
  if (trimmedQuery.startsWith('{') || trimmedQuery.startsWith('[')) {
    try {
      const parsedJson = JSON.parse(trimmedQuery);
      console.log('Detected valid JSON input - skipping AI processing');
      // Return the JSON directly without AI processing
      return res.json({
        response: 'Valid recipe JSON detected. Ready to save.',
        recipeJson: parsedJson
      });
    } catch (jsonError) {
      // Not valid JSON, continue with normal processing
      console.log('Input looks like JSON but failed to parse, proceeding with AI extraction');
    }
  }

  let contentToProcess = userQuery; // Default to user's direct query

  // Check if the userQuery is a URL
  const urlRegex = /^(https?:\/\/[^\s$.?#].[^\s]*)$/i;
  if (urlRegex.test(userQuery)) {
    console.log(`Attempting to fetch content from URL: ${userQuery}`);
    try {
      // Use browser-like headers to avoid bot detection
      const urlObj = new URL(userQuery);
      const response = await fetch(userQuery, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': `${urlObj.origin}/`,
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Cache-Control': 'max-age=0'
        }
      });
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
