variable "namespace" {
  description = "Kubernetes namespace for the stack"
  type        = string
  default     = "telemetry"
}

variable "fleet_size" {
  description = "Number of simulated vehicles"
  type        = number
  default     = 3
}

variable "speed_limit_kph" {
  description = "Global speed limit used by the detector"
  type        = number
  default     = 40
}