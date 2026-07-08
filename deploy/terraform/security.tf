resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "Mastra concierge app: all ingress from the office/VPN ranges + admin SSH, egress all."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-app-sg" }

  # SSH: the deploy machine (admin_cidr) plus the office/VPN ranges.
  ingress {
    description = "SSH (admin + office/VPN)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = concat([var.admin_cidr], var.office_cidrs)
  }

  ingress {
    description = "HTTP (nginx to app)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
  }

  ingress {
    description = "HTTPS (reserved for optional TLS)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
  }

  ingress {
    description = "App port (direct, admin-only debugging)"
    from_port   = 8000
    to_port     = 8000
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
  }

  ingress {
    description = "Mastra Studio (dev/observability UI)"
    from_port   = 4111
    to_port     = 4111
    protocol    = "tcp"
    cidr_blocks = var.office_cidrs
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
