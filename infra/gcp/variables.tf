variable "project" {
  description = "GCP project id"
  type        = string
  default     = "acn-projectroots"
}

variable "project_number" {
  description = "GCP project number (used in WIF principal identifiers)"
  type        = string
  default     = "594390336049"
}

variable "region" {
  description = "Region for regional resources (Artifact Registry)"
  type        = string
  default     = "europe-west3"
}

variable "zone" {
  description = "Zone of the (zonal) GKE cluster"
  type        = string
  default     = "europe-west3-b"
}

variable "cluster_name" {
  description = "GKE cluster name"
  type        = string
  default     = "agent-studio"
}

variable "network" {
  description = "VPC network the cluster lives in (pre-existing, created by deploy/gcp/provision.sh)"
  type        = string
  default     = "agent-studio-net"
}

variable "subnetwork" {
  description = "Subnetwork for the cluster nodes"
  type        = string
  default     = "agent-studio-ew3"
}

variable "node_machine_type" {
  description = "Node machine type (stage 1: e2-standard-2 ≈ stack + 2-3 agents)"
  type        = string
  default     = "e2-standard-2"
}

variable "node_count" {
  description = "Nodes in the default pool. NOTE: >1 requires RWX workspace storage (Filestore) — see deploy/k8s/manifests/20-storage.yaml"
  type        = number
  default     = 1
}

variable "github_repository" {
  description = "GitHub repo (org/name) allowed to authenticate via Workload Identity Federation"
  type        = string
  default     = "AccentureCodeFoundry/314092_agent-execution-environment"
}
