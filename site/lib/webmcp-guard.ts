/**
 * Inline guard for WebMCP. It runs on every page and downloads `/webmcp.js`
 * only when this browser can register tools.
 */

/** Script body. No tool definitions live here. */
export const WEBMCP_GUARD = `(()=>{const mc=(typeof document!=="undefined"&&document.modelContext)||(typeof navigator!=="undefined"&&navigator.modelContext);if(!mc||typeof mc.registerTool!=="function")return;const script=document.createElement("script");script.src="/webmcp.js";script.async=true;document.head.appendChild(script);})();`;
