# Glama inspection image for the Agent Bridge MCP server.
# Installs the published @craftstead/agent-bridge-mcp package from npm and
# runs it as a stdio MCP server. The server needs no secrets or config:
# unpaired, it answers with a structured "unpaired" error.
# This file is not used by the Agent Bridge app build.
FROM node:22-alpine
RUN npm install -g @craftstead/agent-bridge-mcp@0.1.0
USER node
CMD ["agent-bridge-mcp"]
