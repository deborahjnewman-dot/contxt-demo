# contxt-demo

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- An [OpenRouter API key](https://openrouter.ai/)
- A [Brave Search API key](https://brave.com/search/api/)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-org/contxt-demo.git
   cd contxt-demo
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file from the example:

   ```bash
   cp .env.example .env
   ```

4. Fill in your credentials in `.env`:

   ```
   OPENROUTER_API_KEY=your_openrouter_api_key
   BRAVE_SEARCH_API_KEY=your_brave_search_api_key
   ```

### Running locally

```bash
npm start
```

The server starts on [http://localhost:3000](http://localhost:3000) by default. Set the `PORT` environment variable to use a different port.
