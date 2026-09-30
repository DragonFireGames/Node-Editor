// ============================================================
// CONFIGURATION
// ============================================================


// Enable/disable Corsfix fallback.
const USE_CORSFIX_FALLBACK = true;

// Corsfix endpoint.
const CORSFIX_PROXY = "https://proxy.corsfix.com/?";

// HTTP statuses where we should try Corsfix instead.
const CORSFIX_RETRY_STATUSES = new Set([
  403,
  408,
  419,
  429,
  500,
  502,
  503,
  504
]);


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(request, env) {

    // ========================================================
    // CORS HEADERS
    // ========================================================

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400"
    };


    // ========================================================
    // CORS PREFLIGHT
    // ========================================================

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }


    // ========================================================
    // 1. GET AND DECODE TARGET URL
    // ========================================================

    const url = new URL(request.url);

    let targetUrl = url.searchParams.get("url");

    const base64Param =
      url.searchParams.get("base64_url");


    // --------------------------------------------------------
    // Decode URL-safe Base64
    // --------------------------------------------------------

    if (!targetUrl && base64Param) {

      try {

        let normalizedBase64 = base64Param
          .replace(/-/g, "+")
          .replace(/_/g, "/");


        // Restore Base64 padding
        while (normalizedBase64.length % 4) {
          normalizedBase64 += "=";
        }


        // Decode Base64
        const decodedBinary =
          atob(normalizedBase64);


        // Decode UTF-8 safely
        const bytes = Uint8Array.from(
          decodedBinary,
          c => c.charCodeAt(0)
        );

        targetUrl =
          new TextDecoder().decode(bytes);

      } catch (e) {

        return new Response(
          "Invalid base64 encoding",
          {
            status: 400,
            headers: corsHeaders
          }
        );
      }
    }


    // ========================================================
    // TARGET URL REQUIRED
    // ========================================================

    if (!targetUrl) {

      return new Response(
        "Missing url or base64_url parameter",
        {
          status: 400,
          headers: corsHeaders
        }
      );
    }


    // ========================================================
    // 2. VALIDATE TARGET URL
    // ========================================================

    let target;

    try {

      target = new URL(targetUrl);

      if (
        target.protocol !== "http:" &&
        target.protocol !== "https:"
      ) {

        return new Response(
          "Invalid target protocol",
          {
            status: 400,
            headers: corsHeaders
          }
        );
      }

    } catch (e) {

      return new Response(
        "Invalid target URL",
        {
          status: 400,
          headers: corsHeaders
        }
      );
    }


    // ========================================================
    // 3. CLONE INCOMING REQUEST HEADERS
    // ========================================================

    const newHeaders = new Headers(request.headers);

    [
      "host",
      "origin",
      "referer",

      // Browser request context
      "sec-fetch-site",
      "sec-fetch-mode",
      "sec-fetch-dest",
      "sec-fetch-user",

      // Cloudflare
      "cf-connecting-ip",
      "cf-ray",
      "cf-visitor",
      "cf-ipcountry",
      "cf-worker",

      // Proxy chain
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-real-ip"
    ].forEach(h => newHeaders.delete(h));

    if (!newHeaders.has("user-agent")) {
      newHeaders.set(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/141.0.0.0 Safari/537.36"
      );
    }


    // ========================================================
    // 5. USER AGENT
    // ========================================================

    if (!newHeaders.has("user-agent")) {

      newHeaders.set(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/141.0.0.0 Safari/537.36"
      );
    }


    // ========================================================
    // 6. WEBSOCKET
    // ========================================================

    const isWebSocket =
      request.headers.get("Upgrade")?.toLowerCase() ===
      "websocket";


    if (isWebSocket) {

      try {

        return await fetch(target.toString(), {

          method: request.method,

          headers: newHeaders

        });

      } catch (err) {

        return new Response(
          `WebSocket Proxy Error: ${err.message}`,
          {
            status: 502,
            headers: corsHeaders
          }
        );
      }
    }


    // ========================================================
    // 7. PREPARE NORMAL HTTP REQUEST
    // ========================================================

    const init = {

      method: request.method,

      headers: newHeaders,

      redirect: "follow"
    };


    // --------------------------------------------------------
    // Forward request body
    // --------------------------------------------------------

    if (
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {

      init.body =
        await request.arrayBuffer();
    }


    // ========================================================
    // 8. DIRECT TARGET FETCH
    // ========================================================

    let response;

    let directFetchFailed = false;


    try {

      response =
        await fetch(target.toString(), init);

    } catch (err) {

      directFetchFailed = true;

      response = null;
    }


    // ========================================================
    // 9. CORSFIX FALLBACK
    // ========================================================

    const shouldUseCorsfix =
      USE_CORSFIX_FALLBACK &&
      (
        directFetchFailed ||
        (
          response &&
          CORSFIX_RETRY_STATUSES.has(
            response.status
          )
        )
      );


    if (shouldUseCorsfix) {

      try {

        // ----------------------------------------------------
        // Corsfix URL
        //
        // Example:
        //
        // https://proxy.corsfix.com/?https://example.com
        // ----------------------------------------------------

        const corsfixUrl =
          CORSFIX_PROXY +
          target.toString();


        // ----------------------------------------------------
        // IMPORTANT:
        //
        // We need a fresh body because the original
        // request body may already have been consumed
        // by the direct fetch.
        // ----------------------------------------------------

        let corsfixBody = undefined;

        if (
          request.method !== "GET" &&
          request.method !== "HEAD"
        ) {

          corsfixBody =
            await request.clone().arrayBuffer();
        }


        // ----------------------------------------------------
        // Build Corsfix headers
        // ----------------------------------------------------

        const corsfixHeaders =
          new Headers(newHeaders);


        // Add Corsfix API key if configured.
        if (env.CORSFIX_API_KEY) {

          corsfixHeaders.set(
            "x-corsfix-key",
            env.CORSFIX_API_KEY
          );
        }


        // ----------------------------------------------------
        // Fetch through Corsfix
        // ----------------------------------------------------

        const corsfixResponse =
          await fetch(corsfixUrl, {

            method: request.method,

            headers: corsfixHeaders,

            body: corsfixBody,

            redirect: "follow"
          });

          console.log(corsfixUrl);


        // Use Corsfix response if it worked,
        // or if the direct request never worked.
        if (
          corsfixResponse.ok ||
          directFetchFailed
        ) {

          response = corsfixResponse;
        }

      } catch (err) {

        // If Corsfix itself fails and we have a
        // direct response, keep the direct response.

        if (!response) {

          return new Response(
            `Proxy Error: ${err.message}`,
            {
              status: 502,
              headers: corsHeaders
            }
          );
        }
      }
    }


    // ========================================================
    // 10. IF NOTHING WORKED
    // ========================================================

    if (!response) {

      return new Response(
        "Proxy request failed",
        {
          status: 502,
          headers: corsHeaders
        }
      );
    }


    // ========================================================
    // 11. COPY RESPONSE HEADERS
    // ========================================================

    const responseHeaders =
      new Headers();


    for (const [key, value] of response.headers) {

      const lower =
        key.toLowerCase();


      // Remove upstream CORS headers.
      // We provide our own below.

      if (
        lower ===
          "access-control-allow-origin" ||

        lower ===
          "access-control-allow-credentials" ||

        lower ===
          "access-control-allow-methods" ||

        lower ===
          "access-control-allow-headers" ||

        lower ===
          "access-control-expose-headers" ||

        lower ===
          "access-control-max-age"
      ) {

        continue;
      }


      responseHeaders.set(
        key,
        value
      );
    }


    // ========================================================
    // 12. ADD OUR CORS HEADERS
    // ========================================================

    for (
      const [key, value]
      of Object.entries(corsHeaders)
    ) {

      responseHeaders.set(
        key,
        value
      );
    }


    // ========================================================
    // 13. RETURN RESPONSE
    // ========================================================

    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      }
    );
  }
};