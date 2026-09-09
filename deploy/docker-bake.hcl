group "default" {
  targets = ["control-plane", "runtime", "console"]
}
target "base" {
  context = "."
  dockerfile = "deploy/Dockerfile"
}
target "control-plane" {
  inherits = ["base"]
  target = "control-plane"
  tags = ["agent-platform/control-plane:local"]
}
target "runtime" {
  inherits = ["base"]
  target = "runtime"
  tags = ["agent-platform/runtime:local"]
}
target "console" {
  inherits = ["base"]
  target = "console"
  tags = ["agent-platform/console:local"]
}
