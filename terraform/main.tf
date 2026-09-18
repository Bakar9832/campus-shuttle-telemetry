# Terraform against the local Kubernetes cluster.
#
# The point of doing this before touching AWS is that everything here —
# providers, resources, variables, state, plan-vs-apply — is identical against
# any provider. Only the resource names change.

terraform {
  required_version = ">= 1.5"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = "docker-desktop"
}

resource "kubernetes_namespace" "telemetry" {
  metadata {
    name = "${var.namespace}-${terraform.workspace}"
  }
}

resource "kubernetes_deployment" "mosquitto" {
  metadata {
    name      = "mosquitto"
    namespace = kubernetes_namespace.telemetry.metadata[0].name
  }

  spec {
    replicas = 1

    selector {
      match_labels = { app = "mosquitto" }
    }

    template {
      metadata {
        labels = { app = "mosquitto" }
      }

      spec {
        container {
          name    = "mosquitto"
          image   = "eclipse-mosquitto:2"
          args    = ["mosquitto", "-c", "/mosquitto-no-auth.conf"]

          port {
            container_port = 1883
          }
        }
      }
    }
  }
}

resource "kubernetes_service" "mosquitto" {
  metadata {
    name      = "mosquitto"
    namespace = kubernetes_namespace.telemetry.metadata[0].name
  }

  spec {
    selector = { app = "mosquitto" }

    port {
      port        = 1883
      target_port = 1883
    }
  }
}