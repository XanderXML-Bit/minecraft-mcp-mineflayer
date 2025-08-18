declare module "@modelcontextprotocol/sdk/types" {
  export const ListToolsRequestSchema: any
  export const CallToolRequestSchema: any
}

declare module "@modelcontextprotocol/sdk/server/stdio" {
  export class StdioServerTransport {
    constructor(...args: any[])
    start(): Promise<void>
    close(): Promise<void>
    send(message: any, options?: any): Promise<void>
    onclose?: () => void
    onerror?: (error: Error) => void
    onmessage?: (message: any) => void
  }
}


