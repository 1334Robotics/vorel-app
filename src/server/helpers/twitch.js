const DEFAULT_PARENT_DOMAIN = 'vorel.app';

function processParentDomain(domain) {
  // Remove protocol, port, and trailing slashes
  return domain.replace(/^https?:\/\//, '').split(':')[0].replace(/\/$/, '');
}

function getParentDomains(req) {
  const providedDomains = req.query.parent ? req.query.parent.split(",") : [];
  const originDomain = req.headers.origin
    ? new URL(req.headers.origin).hostname
    : "";
  const refererDomain = req.headers.referer
    ? new URL(req.headers.referer).hostname
    : "";
  const hostDomain = req.headers.host ? req.headers.host.split(":")[0] : "";

  const domains = [...providedDomains];
  if (originDomain) domains.push(originDomain);
  if (refererDomain && !domains.includes(refererDomain)) domains.push(refererDomain);
  if (hostDomain && !domains.includes(hostDomain)) domains.push(hostDomain);

  if (DEFAULT_PARENT_DOMAIN && !domains.includes(DEFAULT_PARENT_DOMAIN)) {
    domains.push(DEFAULT_PARENT_DOMAIN);
  }

  return domains.map(processParentDomain).filter(Boolean);
}

module.exports = { getParentDomains };