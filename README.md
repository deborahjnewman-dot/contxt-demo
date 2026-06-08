# contxt-demo

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- An [Anthropic API key](https://console.anthropic.com/)
- A [Brave Search API key](https://brave.com/search/api/)
- A [DeepL API URL](https://www.deepl.com/en/pro-api) (for translation support)

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
   ANTHROPIC_API_KEY=your_anthropic_api_key
   BRAVE_SEARCH_API_KEY=your_brave_search_api_key
   DEEPL_API_URL=your_deepl_api_url
   ```

### Running locally

```bash
npm start
```

The server starts on [http://localhost:3000](http://localhost:3000) by default. Set the `PORT` environment variable to use a different port.
