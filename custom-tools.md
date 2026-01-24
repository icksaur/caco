# Custom Tools

**Critical capability for extending Copilot with application-specific functionality.**

## What Are Custom Tools?

Custom tools are JavaScript/TypeScript functions you define that Copilot can intelligently call during conversations. They run **in-process** within your Node.js application, giving the AI access to your application's capabilities.

## Why Custom Tools?

- **Extend AI capabilities** - Give Copilot access to your APIs, databases, business logic
- **In-process execution** - No subprocess overhead, direct access to application state
- **Type-safe** - Full TypeScript support with Zod schemas
- **Automatic invocation** - AI decides when to call based on user requests
- **Seamless integration** - Results flow naturally into conversation

## Basic Tool Definition

```typescript
import { defineTool } from "@github/copilot-sdk";

const myTool = defineTool("tool_name", {
    description: "Clear description of what the tool does",
    parameters: {
        type: "object",
        properties: {
            arg1: { type: "string", description: "What this arg is for" },
            arg2: { type: "number", description: "Another parameter" }
        },
        required: ["arg1"]
    },
    handler: async (args) => {
        // Your implementation
        const result = await doSomething(args.arg1, args.arg2);
        return result;
    }
});
```

## Type-Safe Tools with Zod

For better type inference, use Zod schemas:

```typescript
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

const getWeather = defineTool("get_weather", {
    description: "Get current weather for a city",
    parameters: z.object({
        city: z.string().describe("The city name"),
        units: z.enum(["celsius", "fahrenheit"]).optional()
    }),
    handler: async (args) => {
        // args is fully typed: { city: string, units?: "celsius" | "fahrenheit" }
        const weather = await fetchWeather(args.city, args.units);
        return {
            city: args.city,
            temperature: weather.temp,
            condition: weather.condition
        };
    }
});
```

## Handler Patterns

### Simple String Return
```typescript
handler: async (args) => {
    return "Operation completed successfully";
}
```

### Structured Object Return
```typescript
handler: async (args) => {
    return {
        status: "success",
        data: { id: 123, name: "Result" }
    };
}
```

### Advanced Result with Metadata
```typescript
handler: async (args) => {
    return {
        textResultForLlm: "Processed 5 records successfully",
        resultType: "success",
        toolTelemetry: {
            recordsProcessed: 5,
            duration: 120
        },
        sessionLog: "Detailed logs for debugging (not sent to AI)"
    };
}
```

### Binary Results (Images, Files)
```typescript
handler: async (args) => {
    const imageBuffer = await generateChart(args.data);
    return {
        textResultForLlm: "Chart generated successfully",
        binaryResultsForLlm: [{
            data: imageBuffer.toString('base64'),
            mimeType: "image/png",
            type: "image",
            description: "Sales chart for Q4"
        }]
    };
}
```

## Handler Context

Your handler receives invocation context:

```typescript
handler: async (args, invocation) => {
    // invocation.sessionId - Current session ID
    // invocation.toolCallId - Unique ID for this tool call
    // invocation.toolName - Name of the tool being called
    
    console.log(`Tool ${invocation.toolName} called in session ${invocation.sessionId}`);
    return result;
}
```

## Using Tools in Sessions

```typescript
const session = await client.createSession({
    model: "gpt-4.1",
    tools: [getWeather, queryDatabase, sendEmail]
});
```

## Real-World Example: Database Query Tool

```typescript
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { db } from "./database";

const queryUsers = defineTool("query_users", {
    description: "Search users in the database by name or email",
    parameters: z.object({
        searchTerm: z.string().describe("Name or email to search for"),
        limit: z.number().optional().default(10)
    }),
    handler: async (args) => {
        try {
            const users = await db.users.search(args.searchTerm, args.limit);
            
            return {
                textResultForLlm: `Found ${users.length} users matching "${args.searchTerm}": ${
                    users.map(u => `${u.name} (${u.email})`).join(', ')
                }`,
                toolTelemetry: {
                    resultCount: users.length,
                    searchTerm: args.searchTerm
                }
            };
        } catch (error) {
            return {
                textResultForLlm: `Error searching users: ${error.message}`,
                resultType: "failure",
                error: error.message
            };
        }
    }
});
```

## AI Decision Making

The AI automatically decides when to call your tools based on:
- Tool name and description
- Parameter descriptions
- User's request context
- Conversation history

**User:** "What's the weather in Seattle?"
→ AI calls `get_weather({ city: "Seattle" })`

**User:** "Find users named John"
→ AI calls `query_users({ searchTerm: "John" })`

## Event Flow

When a tool is called:

1. `tool.execution_start` - Tool invocation begins
2. Your handler executes (in-process)
3. `tool.execution_complete` - Tool finishes with result
4. `assistant.message` - AI incorporates result into response

## Error Handling

Always handle errors gracefully:

```typescript
handler: async (args) => {
    try {
        const result = await riskyOperation(args);
        return result;
    } catch (error) {
        return {
            textResultForLlm: `Operation failed: ${error.message}`,
            resultType: "failure",
            error: error.message,
            sessionLog: error.stack // Private debug info
        };
    }
}
```

## Best Practices

### 1. Clear Descriptions
```typescript
// Good
description: "Get the current weather forecast for a specific city"

// Bad
description: "weather"
```

### 2. Detailed Parameter Descriptions
```typescript
parameters: z.object({
    city: z.string().describe("The city name (e.g., 'Seattle', 'Tokyo')"),
    includeHourly: z.boolean().describe("Whether to include hourly forecast").optional()
})
```

### 3. Return Useful Context
```typescript
// Include context the AI can use
return `Found ${results.length} results: ${results.map(r => r.summary).join(', ')}`;

// Not just:
return "Success";
```

### 4. Handle Edge Cases
```typescript
if (!args.city) {
    return { textResultForLlm: "City name is required", resultType: "failure" };
}

if (results.length === 0) {
    return `No results found for "${args.searchTerm}"`;
}
```

### 5. Use Tool Telemetry
```typescript
return {
    textResultForLlm: "Operation completed",
    toolTelemetry: {
        duration: Date.now() - startTime,
        recordsProcessed: count,
        apiCalls: apiCallCount
    }
};
```

## Custom Tools vs MCP Tools

| Feature | Custom Tools | MCP Tools |
|---------|-------------|-----------|
| Execution | In-process | Out-of-process subprocess |
| Performance | Fast, no IPC | Slower, process spawning |
| Access | Full app state | Isolated |
| Language | JavaScript/TypeScript | Any language |
| Setup | Simple function | Separate server process |
| Use Case | App-specific logic | Reusable external tools |

## When to Use Custom Tools

**Use custom tools for:**
- Database queries
- API calls to your services
- Business logic specific to your app
- Calculations and data processing
- In-memory operations
- Quick operations that benefit from in-process execution

**Use MCP tools for:**
- Reusable tools across projects
- Language-specific tools (Python ML, etc.)
- Long-running operations
- Tools that need isolation
- Pre-built tool servers

## Multiple Tools Example

```typescript
const tools = [
    defineTool("get_user", {
        description: "Get user details by ID",
        parameters: z.object({ userId: z.number() }),
        handler: async ({ userId }) => {
            const user = await db.users.findById(userId);
            return `User: ${user.name}, Email: ${user.email}`;
        }
    }),
    
    defineTool("send_notification", {
        description: "Send a notification to a user",
        parameters: z.object({
            userId: z.number(),
            message: z.string()
        }),
        handler: async ({ userId, message }) => {
            await notifications.send(userId, message);
            return "Notification sent successfully";
        }
    }),
    
    defineTool("calculate_analytics", {
        description: "Calculate user engagement analytics",
        parameters: z.object({
            userId: z.number(),
            dateRange: z.object({
                start: z.string(),
                end: z.string()
            })
        }),
        handler: async ({ userId, dateRange }) => {
            const stats = await analytics.calculate(userId, dateRange);
            return `User engagement: ${stats.sessions} sessions, ${stats.duration}min total`;
        }
    })
];

const session = await client.createSession({
    model: "gpt-4.1",
    tools
});
```

## Conversation Flow

**User:** "Get details for user 123 and send them a welcome message"

**AI Response:**
1. Calls `get_user({ userId: 123 })`
2. Receives: "User: John Doe, Email: john@example.com"
3. Calls `send_notification({ userId: 123, message: "Welcome!" })`
4. Receives: "Notification sent successfully"
5. Responds: "I found John Doe (john@example.com) and sent them a welcome notification."

The AI orchestrates multiple tool calls automatically based on the user's request.
