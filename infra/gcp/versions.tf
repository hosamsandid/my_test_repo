terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Shared project state bucket, one prefix per stack (accessio convention;
  # its bootstrap created the bucket — versioned + CMEK — and uses the
  # sibling prefixes "auth", "env/uat", "env/uat-k8s").
  backend "gcs" {
    bucket = "acn-projectroots-tfstate-5c615c28"
    prefix = "env/agent-studio"
  }
}

provider "google" {
  project = var.project
  region  = var.region
}
