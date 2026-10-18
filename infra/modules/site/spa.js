// CloudFront Function on the default (PWA) behaviour's viewer requests: an app route such as
// /recipes/abc has no file extension, so it gets the bundle's index.html. /api/* and /images/*
// have their own behaviours and never reach this function.
function handler(event) {
  var request = event.request;
  var last = request.uri.split("/").pop();
  if (last.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
