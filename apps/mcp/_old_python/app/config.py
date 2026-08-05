"""MCP server configuration from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Server
    mcp_port: int = 4650
    mcp_issuer_url: str = "http://localhost:4650"
    mcp_resource_url: str = "http://localhost:4650/mcp"

    # TaskPilot API
    taskpilot_api_url: str = "http://api:4647"
    taskpilot_api_key: str = ""
    taskpilot_workspace_slug: str = ""

    # Database
    database_url: str = ""

    # Redis
    redis_url: str = "redis://localhost:6379/7"

    # LLM (smart routing)
    llm_api_base_url: str = "http://nuc.lan:4000"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"

    # OAuth TTLs
    mcp_access_token_ttl: int = 3600
    mcp_refresh_token_ttl: int = 2592000
    mcp_auth_code_ttl: int = 600

    # Frontend (for OAuth consent redirect)
    frontend_url: str = "https://taskpilot.sudiptadhara.in"

    # Dynamic client registration (RFC 7591)
    mcp_dynamic_registration: bool = True

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
