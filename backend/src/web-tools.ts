import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { log } from "./logger.js";

/** Strip HTML tags and decode entities, return clean text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function registerWebTools(server: McpServer): void {

  // --- web_search ---
  server.tool(
    "web_search",
    "Search the web for current information. Returns search results with titles, URLs, and snippets. Use this for looking up stocks, weather, news, facts, or anything that needs up-to-date info.",
    {
      query: z.string().describe("The search query"),
    },
    async ({ query }) => {
      log("[mcp] Tool called: web_search", JSON.stringify({ query }));
      try {
        // Use DuckDuckGo HTML search (no API key needed)
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AIAssistant/1.0)",
          },
        });
        const html = await res.text();

        // Parse results from DDG HTML
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
          const rawUrl = match[1];
          // DDG wraps URLs in a redirect — extract the actual URL
          const actualUrl = decodeURIComponent(
            rawUrl.replace(/.*uddg=([^&]*).*/, "$1") || rawUrl
          );
          results.push({
            title: htmlToText(match[2]),
            url: actualUrl,
            snippet: htmlToText(match[3]),
          });
        }

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results found for "${query}"` }] };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join("\n\n");

        return { content: [{ type: "text" as const, text: formatted }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Search error: ${err}` }] };
      }
    }
  );

  // --- web_fetch ---
  server.tool(
    "web_fetch",
    "Fetch and read the content of a web page. Returns the page text with HTML stripped. Use after web_search to read a specific result, or to fetch any URL directly (stock prices, weather, articles, etc.).",
    {
      url: z.string().describe("The URL to fetch"),
      maxLength: z.number().optional().default(5000).describe("Max characters to return (default 5000)"),
    },
    async ({ url, maxLength }) => {
      log("[mcp] Tool called: web_fetch", JSON.stringify({ url }));
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AIAssistant/1.0)",
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `HTTP ${res.status}: ${res.statusText}` }] };
        }

        const html = await res.text();
        let text = htmlToText(html);

        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + "\n\n[Truncated — use maxLength parameter for more]";
        }

        return { content: [{ type: "text" as const, text: text || "Page returned no readable text content" }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Fetch error: ${err}` }] };
      }
    }
  );
}
