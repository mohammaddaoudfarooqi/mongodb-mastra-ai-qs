resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app-sg"
  description = "Mastra concierge app: all ingress from admin_cidr (VPN), egress all."
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name_prefix}-app-sg" }

  ingress {
    description = "SSH (admin)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "HTTP (nginx to app)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "HTTPS (reserved for optional TLS)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "App port (direct, admin-only debugging)"
    from_port   = 8000
    to_port     = 8000
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "Mastra Studio (dev/observability UI)"
    from_port   = 4111
    to_port     = 4111
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
