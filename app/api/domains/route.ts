import { NextRequest, NextResponse } from "next/server";

export type Domain = {
  available: boolean;
  definitive: boolean;
  domain: string;
  period?: number;
  price?: number;
  currency?: string;
};

async function getAvailableDomains(domainNames: string[]) {
  if (domainNames.length === 0) {
    return [];
  }

  const response = await fetch(
    `${process.env.GODADDY_URL}/v1/domains/available`,
    {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `sso-key ${process.env.GODADDY_API_KEY}:${process.env.GODADDY_API_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(domainNames),
    }
  );

  // If GoDaddy are throttling us then we assume all domains are available
  if (!response.ok) {
    console.log("GoDaddy not ok", response.status);
    return domainNames.map<Domain>((domainName) => ({
      available: true,
      definitive: false,
      domain: domainName,
    }));
  }

  const availability: { domains: Domain[] } = await response.json();
  console.log("GoDaddy ok", availability);

  return availability.domains.filter((domain) => domain.available);
}

let domainRegex: RegExp;

async function initialize() {
  if (domainRegex) {
    return;
  }

  const tlds: { name: string; type: "COUNTRY_CODE" | "GENERIC" }[] =
    await fetch(`${process.env.GODADDY_URL}/v1/domains/tlds`, {
      headers: {
        Authorization: `sso-key ${process.env.GODADDY_API_KEY}:${process.env.GODADDY_API_SECRET}`,
      },
    }).then((response) => response.json());

  domainRegex = new RegExp(
    `[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\\.(?:${tlds
      .map(({ name }) => name.replace(/\./g, "\\."))
      .join("|")})`,
    "gi"
  );
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export async function GET(request: NextRequest) {
  await initialize();

  let description = "test domain name generator";

  // Make sure description is 100 characters or less
  description = description.slice(0, 100);

  const stream = new ReadableStream({
    async start(controller) {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            stream: true,
            messages: [
              {
                role: "user",
                content: `List some suitable domain names for my project in CSV format. Description of my project: "${description}"`,
              },
            ],
          }),
        }
      );

      if (response.body === null) {
        console.log("No body", response.status);
        return;
      }

      const reader = response.body.getReader();

      let completeResponse = "";
      const domainNamesFound: string[] = [];
      const pendingPromises: Promise<void>[] = [];

      let incompleteLine = "";
      readWhile: while (true) {
        const { value, done } = await reader.read();

        if (done) {
          console.log("open ai done");
          break readWhile;
        }
        let decoded = textDecoder.decode(value);
        console.log("openai decoded", decoded);
        if (!decoded.endsWith("\n")) {
          console.log("incomplete");
          incompleteLine += decoded;
          continue;
        }
        decoded = incompleteLine + decoded;
        incompleteLine = "";
        const lines = decoded.split(/\n+/);

        console.log("openai lines", lines.length);

        for (let data of lines) {
          if (!data.trim()) {
            continue;
          }
          data = data.trim().replace(/^data: /, "");

          if (data.includes("[DONE]")) {
            console.log("open ai done via message");
            break readWhile;
          }

          try {
            const [choice] = JSON.parse(data).choices;

            // Add delta to complete response
            completeResponse += choice.delta.content;

            // Find new domain names in the complete response
            const newDomainNames = [
              ...(completeResponse.matchAll(domainRegex) ?? []),
            ]
              .map(([domainName]) => domainName.toLowerCase())
              .filter(
                (domainName) =>
                  domainName.length < 25 &&
                  !domainNamesFound.includes(domainName)
              );

            domainNamesFound.push(...newDomainNames);

            const pendingPromise = getAvailableDomains(newDomainNames).then(
              (availableDomains) => {
                // Return available domains separated by |
                if (availableDomains.length > 0) {
                  console.log("controller enqueue", availableDomains);
                  controller.enqueue(
                    textEncoder.encode(
                      availableDomains
                        .map((availableDomain) =>
                          JSON.stringify(availableDomain)
                        )
                        .join("|") + "|"
                    )
                  );
                }
              }
            );

            pendingPromises.push(pendingPromise);
          } catch {
            if (data) {
              console.log("Failed to parse", data);
            }
            // Ignore lines that we fail to parse
          }
        }
      }

      // Wait for all availability checks to finish
      await Promise.all(pendingPromises);
      console.log("pendingPromises");

      // Wait a bit more for all the chunks to send
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log("timeout");

      // Close the stream
      console.log("controller close");
      controller.close();
    },
  });

  return new NextResponse(stream);
}

export const runtime = "experimental-edge";
