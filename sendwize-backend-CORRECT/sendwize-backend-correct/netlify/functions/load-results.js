exports.handler = async (event, context) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Get the user ID from the query parameters
    const userId = event.queryStringParameters.userId;
    
    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'User ID is required' })
      };
    }

    // Get Airtable credentials from environment variables (secure!)
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const BASE_ID = process.env.BASE_ID;
    const TABLE_NAME = process.env.TABLE_NAME;

    // Build the Airtable URL with the filter
    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_NAME}?filterByFormula={UserID}='${userId}'&sort[0][field]=SubmissionDate&sort[0][direction]=desc`;

    // Make the request to Airtable
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_TOKEN}`
      }
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error('Failed to fetch data from Airtable');
    }

    // Send success response back to Webflow
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Allows your Webflow site to call this
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};
