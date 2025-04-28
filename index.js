const path = require('path')
const { spawn } = require('child_process')

const dotenv = require('dotenv')
// Import required bot configuration.
const ENV_FILE = path.join(__dirname, '.env')
dotenv.config({ path: ENV_FILE })

const restify = require('restify')

// Import required bot services.
// See https://aka.ms/bot-services to learn more about the different parts of a bot.
const {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration
} = require('botbuilder')

// This bot's main dialog.
const { EchoBot } = require('./bot')

const axios = require('axios')
const { v4: uuidv4 } = require('uuid') // For generating unique session IDs

// Start the RooLLM Python server
const pythonProcess = spawn('npm', ['run', 'RooLLM'], {
  cwd: path.join(__dirname, 'roollm'),
  env: { ...process.env },
  shell: true
})

pythonProcess.stdout.on('data', (data) => {
  console.log(`[RooLLM]: ${data}`)
})

pythonProcess.stderr.on('data', (data) => {
  console.error(`[RooLLM Error]: ${data}`)
})

pythonProcess.on('close', (code) => {
  console.log(`RooLLM process exited with code ${code}`)
})

// Create HTTP server
const server = restify.createServer()
server.use(restify.plugins.bodyParser())

server.listen(process.env.port || process.env.PORT || 3978, () => {
  console.log(`\n${server.name} listening to ${server.url}`)
  console.log('\nGet Bot Framework Emulator: https://aka.ms/botframework-emulator')
  console.log('\nTo talk to your bot, open the emulator select "Open Bot"')
})

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: process.env.MicrosoftAppId,
  MicrosoftAppPassword: process.env.MicrosoftAppPassword,
  MicrosoftAppType: process.env.MicrosoftAppType,
  MicrosoftAppTenantId: process.env.MicrosoftAppTenantId
})

const botFrameworkAuthentication = createBotFrameworkAuthenticationFromConfiguration(null, credentialsFactory)

// Create adapter.
// See https://aka.ms/about-bot-adapter to learn more about adapters.
const adapter = new CloudAdapter(botFrameworkAuthentication)

// Catch-all for errors.
const onTurnErrorHandler = async (context, error) => {
  // This check writes out errors to console log .vs. app insights.
  // NOTE: In production environment, you should consider logging this to Azure
  //       application insights.
  console.error(`\n [onTurnError] unhandled error: ${error}`)

  // Send a trace activity, which will be displayed in Bot Framework Emulator
  await context.sendTraceActivity(
    'OnTurnError Trace',
    `${error}`,
    'https://www.botframework.com/schemas/error',
    'TurnError'
  )

  // Send a message to the user
  await context.sendActivity('The bot encountered an error or bug.')
  await context.sendActivity('To continue to run this bot, please fix the bot source code.')
}

// Set the onTurnError for the singleton CloudAdapter.
adapter.onTurnError = onTurnErrorHandler

// Create the main dialog.
const myBot = new EchoBot()

// Store conversation history and session IDs
const conversationHistory = {}
const sessionIds = {}

// Listen for incoming requests.
server.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, async (context) => {
    const userId = context.activity.from.id
    const userMessage = context.activity.text

    // Skip if no message or if it's not a message activity
    if (!userMessage || context.activity.type !== 'message') {
      return;
    }

    // Initialize session ID if it doesn't exist
    if (!sessionIds[userId]) {
      sessionIds[userId] = uuidv4() // Generate a unique session ID
    }

    const sessionId = sessionIds[userId]

    // Initialize conversation history if it doesn't exist
    if (!conversationHistory[sessionId]) {
      conversationHistory[sessionId] = []
    }

    // Add the user's message to the history
    conversationHistory[sessionId].push({ role: 'user', content: userMessage })

    try {
      // Send the request to the RooLLM server
      const response = await axios.post('http://127.0.0.1:8000/chat', {
        message: userMessage,
        session_id: sessionId
      }, {
        responseType: 'stream' // Handle streaming response
      })

      // Process the streamed response
      let botReply = ''
      
      // Create a promise to handle the stream
      await new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => {
          try {
            const data = JSON.parse(chunk.toString().replace(/^data: /, '').trim())
            if (data.type === 'reply') {
              botReply += data.content
            }
          } catch (error) {
            console.error('Error parsing chunk:', error)
          }
        })

        response.data.on('end', () => resolve())
        response.data.on('error', (error) => reject(error))
      })

      // Add the bot's reply to the history
      conversationHistory[sessionId].push({ role: 'assistant', content: botReply })

      // Send the bot's reply to the user
      await context.sendActivity(botReply)
    } catch (error) {
      console.error('Error communicating with RooLLM:', error)
      await context.sendActivity('Sorry, there was an error processing your request.')
    }
  })
})

// Listen for Upgrade requests for Streaming.
server.on('upgrade', async (req, socket, head) => {
  // Create an adapter scoped to this WebSocket connection to allow storing session data.
  const streamingAdapter = new CloudAdapter(botFrameworkAuthentication)

  // Set onTurnError for the CloudAdapter created for each connection.
  streamingAdapter.onTurnError = onTurnErrorHandler

  await streamingAdapter.process(req, socket, head, (context) => myBot.run(context))
})
