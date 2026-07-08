resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "Mastra concierge app: all traffic from the office/VPN ranges + admin SSH, egress all."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-app-sg" }

  # Office/VPN ranges get all traffic (matches the maap-temporal reference posture).
  # Per-port rules × 31 CIDRs would blow past AWS's 60-rule/SG limit, so use one
  # all-protocol rule per CIDR (~31 rules). These are trusted corporate ranges.
  ingress {
    description = "All traffic from office/VPN ranges"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = var.office_cidrs
  }

  # The deploy machine keeps SSH regardless of the office list.
  ingress {
    description = "SSH (deploy machine)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  # Egress all: Bedrock, SSM, KMS, git clone, docker pulls, and Atlas SRV DNS.
  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
