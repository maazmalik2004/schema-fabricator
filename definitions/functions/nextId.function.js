function nextId() {
  const id = schema.state.Demo.nextId;
  schema.state.Demo.nextId += 1;
  return id;
}
