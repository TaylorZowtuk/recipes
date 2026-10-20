// CloudFront Function on every behaviour's viewer responses: keep the household's site out of
// search engines. The Free plan forbids custom response headers policies, so a function adds it.
function handler(event) {
  var response = event.response;
  response.headers["x-robots-tag"] = { value: "noindex" };
  return response;
}
