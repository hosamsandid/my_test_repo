terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # State is local for the initial import. Before this module is shared,
  # switch to the team's GCS state bucket (align with the accessio
  # conventions in acn-projectroots):
  #
  # backend "gcs" {
  #   bucket = "<state-bucket>"
  #   prefix = "agent-studio"
  # }
}

provider "google" {
  project = var.project
  region  = var.region
}
