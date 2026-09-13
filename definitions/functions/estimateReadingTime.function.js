function estimateReadingTime(article) {
  return Math.max(1, Math.ceil(article.body.trim().split(/\s+/).filter(Boolean).length / 200));
}
