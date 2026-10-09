// Links with an injected DNS lookup and fetch — no network in these tests (only reserved example domains).
import { expect, test } from "bun:test";
import { fetchLink, htmlToText, isPrivateAddress, type LinkDeps } from "../../src/sources/link";

const PUBLIC = "93.184.215.14";

// A fake world: host → addresses, URL → response.
function world(hosts: Record<string, string[]>, pages: Record<string, () => Response>): LinkDeps {
  return {
    lookup: async (host: string) => {
      const addrs = hosts[host];
      if (!addrs) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    fetch: async (url: string) => {
      const page = pages[url];
      if (!page) throw new Error("connection refused");
      return page();
    },
  };
}

test("private, loopback, link-local and unique-local addresses are recognised", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1",
    "100.64.0.1", "0.0.0.0", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.1", "::ffff:7f00:1"]) {
    expect([a, isPrivateAddress(a)]).toEqual([a, true]);
  }
  for (const a of [PUBLIC, "172.32.0.1", "100.128.0.1", "2606:2800:220:1::1", "::ffff:93.184.215.14"]) {
    expect([a, isPrivateAddress(a)]).toEqual([a, false]);
  }
});

test("only http and https; a host resolving to any private address is refused", async () => {
  const deps = world({
    "loop.example.com": ["127.0.0.1"], "ten.example.com": ["10.1.2.3"], "six.example.com": ["::1"],
    "mapped.example.com": ["::ffff:192.168.1.1"], "mixed.example.com": [PUBLIC, "10.0.0.1"],
  }, {});
  expect((await fetchLink("ftp://files.example.com/a.pdf", deps)).kind).toBe("refused");
  for (const host of ["loop", "ten", "six", "mapped", "mixed"]) {
    expect([host, (await fetchLink(`https://${host}.example.com/`, deps)).kind]).toEqual([host, "refused"]);
  }
});

test("a redirect from a public address to a private one is refused", async () => {
  const deps = world({ "www.example.com": [PUBLIC], "inside.example.org": ["192.168.0.10"] }, {
    "https://www.example.com/go": () => new Response(null, { status: 302, headers: { location: "https://inside.example.org/admin" } }),
  });
  expect((await fetchLink("https://www.example.com/go", deps)).kind).toBe("refused");
});

test("HTML becomes visible text without scripts; the final URL is the name", async () => {
  const html = `<html><head><title>ห้องประชุม</title><style>p{color:red}</style><script>var secret = "drop me";</script></head>
    <body><h1>กฎการจอง</h1><p>ห้องที่จุเกิน 10 คน &amp; ผู้ดูแล</p><noscript>no js</noscript><div>ok</div></body></html>`;
  const deps = world({ "www.example.com": [PUBLIC] }, {
    "https://www.example.com/a": () => new Response(null, { status: 301, headers: { location: "/rules" } }),
    "https://www.example.com/rules": () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  const r = await fetchLink("https://www.example.com/a", deps);
  expect(r.kind).toBe("fetched");
  if (r.kind !== "fetched") return;
  expect(r.name).toBe("https://www.example.com/rules");
  expect(r.outcome.status).toBe("read");
  const text = r.outcome.status === "read" ? r.outcome.text : "";
  expect(text).toContain("กฎการจอง");
  expect(text).toContain("ห้องที่จุเกิน 10 คน & ผู้ดูแล");
  expect(text).not.toContain("drop me");
  expect(text).not.toContain("color:red");
  expect(text).not.toContain("no js");
  expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\nb");
});

test("too large, unreachable and unsupported links are failed sources, not errors", async () => {
  const big = new Uint8Array(6_000_000).fill(65);
  const deps = world({ "www.example.com": [PUBLIC] }, {
    "https://www.example.com/big": () => new Response(big, { headers: { "content-type": "text/plain" } }),
    "https://www.example.com/missing": () => new Response("nope", { status: 404 }),
    "https://www.example.com/zip": () => new Response("PK..", { headers: { "content-type": "application/zip" } }),
    "https://www.example.com/plain": () => new Response("ข้อความธรรมดา", { headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
  const reason = async (u: string) => {
    const r = await fetchLink(u, deps);
    return r.kind === "fetched" && r.outcome.status === "failed" ? r.outcome.reason : r.kind;
  };
  expect(await reason("https://www.example.com/big")).toBe("link_too_large");
  expect(await reason("https://www.example.com/missing")).toBe("link_unreachable");
  expect(await reason("https://www.example.com/gone")).toBe("link_unreachable");
  expect(await reason("https://www.example.com/zip")).toBe("link_unsupported");
  const plain = await fetchLink("https://www.example.com/plain", deps);
  expect(plain.kind === "fetched" && plain.outcome.status === "read" && plain.outcome.text).toBe("ข้อความธรรมดา");
});

test("IPv4 disguised inside IPv6 (compatible, NAT64, 6to4) is checked as the IPv4 it carries", () => {
  for (const a of ["::7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2002:c0a8:101::1"]) {
    expect([a, isPrivateAddress(a)]).toEqual([a, true]);
  }
  for (const a of ["64:ff9b::5db8:d70e", "2002:5db8:d70e::1"]) expect([a, isPrivateAddress(a)]).toEqual([a, false]);
});

test("a failed DNS lookup is unreachable and nothing is fetched", async () => {
  let fetched = 0;
  const r = await fetchLink("https://nowhere.example.com/x", {
    lookup: async () => { throw Object.assign(new Error("dns"), { code: "SERVFAIL" }); },
    fetch: async () => { fetched++; return new Response("x"); },
  });
  expect(r.kind === "fetched" && r.outcome.status === "failed" && r.outcome.reason).toBe("link_unreachable");
  expect(fetched).toBe(0);
});

test("a malformed redirect is unreachable; a bad entity does not break the page; credentials leave the name", async () => {
  const deps = world({ "www.example.com": [PUBLIC] }, {
    "https://www.example.com/r": () => new Response(null, { status: 302, headers: { location: "http://[" } }),
    "https://www.example.com/e": () => new Response("<p>a &#x110000; b &#99999999; c</p>", { headers: { "content-type": "text/html" } }),
    "https://user:secret@www.example.com/p": () => new Response("hi", { headers: { "content-type": "text/plain" } }),
  });
  const r = await fetchLink("https://www.example.com/r", deps);
  expect(r.kind === "fetched" && r.outcome.status === "failed" && r.outcome.reason).toBe("link_unreachable");
  const e = await fetchLink("https://www.example.com/e", deps);
  expect(e.kind === "fetched" && e.outcome.status === "read" && e.outcome.text).toBe("a &#x110000; b &#99999999; c");
  const p = await fetchLink("https://user:secret@www.example.com/p", deps);
  expect(p.kind === "fetched" && p.name).toBe("https://www.example.com/p");
});
