/* =====================================================================
   Invoice app - database schema for Azure SQL Database (T-SQL)
   Run once in the Azure portal: your database > Query editor.
   Money is DECIMAL(18,2). Dates are stored in UTC (DATETIME2) or as DATE.
   ===================================================================== */

/* ---------- Business settings (always exactly one row) ---------- */
CREATE TABLE dbo.app_settings (
    id                  INT           NOT NULL CONSTRAINT PK_app_settings PRIMARY KEY
                                      CONSTRAINT CK_app_settings_single CHECK (id = 1),
    business_name       NVARCHAR(200) NOT NULL,
    business_address    NVARCHAR(500) NULL,
    gst_reg_no          NVARCHAR(50)  NULL,          -- leave NULL if not GST-registered
    uen                 NVARCHAR(50)  NULL,
    default_gst_rate    DECIMAL(5,2)  NOT NULL CONSTRAINT DF_settings_gst DEFAULT 9.00,
    default_currency    CHAR(3)       NOT NULL CONSTRAINT DF_settings_cur DEFAULT 'SGD',
    payment_terms_days  INT           NOT NULL CONSTRAINT DF_settings_terms DEFAULT 14,
    payment_details     NVARCHAR(MAX) NULL,          -- bank account / PayNow text shown on invoices
    invoice_footer      NVARCHAR(MAX) NULL,
    updated_at          DATETIME2     NOT NULL CONSTRAINT DF_settings_upd DEFAULT SYSUTCDATETIME()
);

/* ---------- Staff logins (about 10 people) ---------- */
CREATE TABLE dbo.users (
    id              INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_users PRIMARY KEY,
    username        NVARCHAR(100) NOT NULL CONSTRAINT UQ_users_username UNIQUE,
    display_name    NVARCHAR(150) NOT NULL,
    email           NVARCHAR(255) NULL,
    password_hash   NVARCHAR(255) NOT NULL,          -- bcrypt hash, never the password itself
    role            NVARCHAR(20)  NOT NULL CONSTRAINT DF_users_role DEFAULT 'staff'
                                  CONSTRAINT CK_users_role CHECK (role IN ('admin', 'staff')),
    is_active       BIT           NOT NULL CONSTRAINT DF_users_active DEFAULT 1,
    failed_attempts INT           NOT NULL CONSTRAINT DF_users_failed DEFAULT 0,
    locked_until    DATETIME2     NULL,
    last_login_at   DATETIME2     NULL,
    created_at      DATETIME2     NOT NULL CONSTRAINT DF_users_created DEFAULT SYSUTCDATETIME()
);

/* ---------- Clients ---------- */
CREATE TABLE dbo.clients (
    id             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_clients PRIMARY KEY,
    business_name  NVARCHAR(200) NOT NULL,
    gst_reg_no     NVARCHAR(50)  NULL,
    address        NVARCHAR(500) NULL,
    email          NVARCHAR(255) NULL,
    is_active      BIT           NOT NULL CONSTRAINT DF_clients_active DEFAULT 1,
    created_at     DATETIME2     NOT NULL CONSTRAINT DF_clients_created DEFAULT SYSUTCDATETIME(),
    updated_at     DATETIME2     NOT NULL CONSTRAINT DF_clients_updated DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_clients_name ON dbo.clients (business_name);

/* ---------- Products & services ---------- */
CREATE TABLE dbo.product_categories (
    id        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_product_categories PRIMARY KEY,
    name      NVARCHAR(150) NOT NULL CONSTRAINT UQ_product_categories_name UNIQUE,
    position  INT           NOT NULL CONSTRAINT DF_pc_position DEFAULT 0
);

CREATE TABLE dbo.products (
    id           INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_products PRIMARY KEY,
    category_id  INT           NULL CONSTRAINT FK_products_category
                               REFERENCES dbo.product_categories (id),
    name         NVARCHAR(300) NOT NULL,
    unit_price   DECIMAL(18,2) NOT NULL,             -- price BEFORE GST
    gst_rate     DECIMAL(5,2)  NOT NULL CONSTRAINT DF_products_gst DEFAULT 9.00,
    unit         NVARCHAR(30)  NULL,
    position     INT           NOT NULL CONSTRAINT DF_products_position DEFAULT 0,
    is_active    BIT           NOT NULL CONSTRAINT DF_products_active DEFAULT 1,
    created_at   DATETIME2     NOT NULL CONSTRAINT DF_products_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_products_category ON dbo.products (category_id);

/* ---------- Invoice numbering ----------
   Allocate the next number inside the same transaction that saves the invoice:
     UPDATE dbo.number_sequences
        SET next_value = next_value + 1
     OUTPUT deleted.next_value
      WHERE seq_key = 'invoice';
   A rolled-back transaction does not use up a number. */
CREATE TABLE dbo.number_sequences (
    seq_key     NVARCHAR(50) NOT NULL CONSTRAINT PK_number_sequences PRIMARY KEY,
    next_value  INT          NOT NULL
);

/* ---------- Invoices ----------
   Client details and line items are COPIED onto the invoice, so editing a
   client or product later never changes an invoice that was already issued. */
CREATE TABLE dbo.invoices (
    id               INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_invoices PRIMARY KEY,
    doc_type         NVARCHAR(20)  NOT NULL CONSTRAINT DF_invoices_type DEFAULT 'tax_invoice'
                                   CONSTRAINT CK_invoices_type
                                   CHECK (doc_type IN ('tax_invoice', 'invoice', 'quote', 'credit_note')),
    number_prefix    NVARCHAR(20)  NULL,
    number_seq       INT           NOT NULL,
    invoice_no       NVARCHAR(50)  NOT NULL CONSTRAINT UQ_invoices_no UNIQUE,

    issue_date       DATE          NOT NULL,
    due_date         DATE          NOT NULL,
    currency         CHAR(3)       NOT NULL CONSTRAINT DF_invoices_cur DEFAULT 'SGD',
    sgd_exchange_rate DECIMAL(18,6) NULL,            -- needed for GST in SGD when currency <> SGD
    reference_no     NVARCHAR(100) NULL,
    notes            NVARCHAR(MAX) NULL,
    email_text       NVARCHAR(MAX) NULL,

    client_id        INT           NULL CONSTRAINT FK_invoices_client REFERENCES dbo.clients (id),
    client_name      NVARCHAR(200) NOT NULL,
    client_gst_reg_no NVARCHAR(50) NULL,
    client_address   NVARCHAR(500) NULL,
    client_email     NVARCHAR(255) NULL,

    status           NVARCHAR(20)  NOT NULL CONSTRAINT DF_invoices_status DEFAULT 'unpaid'
                                   CONSTRAINT CK_invoices_status
                                   CHECK (status IN ('draft', 'unpaid', 'paid', 'void')),
    subtotal_ex_gst  DECIMAL(18,2) NOT NULL CONSTRAINT DF_invoices_sub DEFAULT 0,
    gst_total        DECIMAL(18,2) NOT NULL CONSTRAINT DF_invoices_gst DEFAULT 0,
    total            DECIMAL(18,2) NOT NULL CONSTRAINT DF_invoices_total DEFAULT 0,
    paid_at          DATETIME2     NULL,

    sent_at          DATETIME2     NULL,
    sent_to          NVARCHAR(255) NULL,
    first_viewed_at  DATETIME2     NULL,

    voided_at        DATETIME2     NULL,
    voided_by        INT           NULL CONSTRAINT FK_invoices_voided_by REFERENCES dbo.users (id),
    void_reason      NVARCHAR(500) NULL,

    position         INT           NOT NULL CONSTRAINT DF_invoices_position DEFAULT 0,
    created_by       INT           NULL CONSTRAINT FK_invoices_created_by REFERENCES dbo.users (id),
    created_at       DATETIME2     NOT NULL CONSTRAINT DF_invoices_created DEFAULT SYSUTCDATETIME(),
    updated_at       DATETIME2     NOT NULL CONSTRAINT DF_invoices_updated DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_invoices_issue_date ON dbo.invoices (issue_date);
CREATE INDEX IX_invoices_status     ON dbo.invoices (status);
CREATE INDEX IX_invoices_client     ON dbo.invoices (client_id);

CREATE TABLE dbo.invoice_items (
    id             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_invoice_items PRIMARY KEY,
    invoice_id     INT           NOT NULL CONSTRAINT FK_items_invoice
                                 REFERENCES dbo.invoices (id) ON DELETE CASCADE,
    line_no        INT           NOT NULL,
    product_id     INT           NULL CONSTRAINT FK_items_product REFERENCES dbo.products (id),
    name           NVARCHAR(300) NOT NULL,
    unit_price     DECIMAL(18,2) NOT NULL,           -- before GST
    gst_rate       DECIMAL(5,2)  NOT NULL,
    quantity       DECIMAL(18,3) NOT NULL CONSTRAINT DF_items_qty DEFAULT 1,
    unit           NVARCHAR(30)  NULL,
    discount_type  NVARCHAR(10)  NOT NULL CONSTRAINT DF_items_dtype DEFAULT 'percent'
                                 CONSTRAINT CK_items_dtype CHECK (discount_type IN ('percent', 'amount')),
    discount_value DECIMAL(18,2) NOT NULL CONSTRAINT DF_items_dvalue DEFAULT 0,
    line_net       DECIMAL(18,2) NOT NULL,           -- after discount, before GST
    line_gst       DECIMAL(18,2) NOT NULL,
    line_total     DECIMAL(18,2) NOT NULL,
    CONSTRAINT UQ_items_line UNIQUE (invoice_id, line_no)
);

/* ---------- Audit trail (who did what) ---------- */
CREATE TABLE dbo.audit_log (
    id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_audit_log PRIMARY KEY,
    user_id     INT           NULL CONSTRAINT FK_audit_user REFERENCES dbo.users (id),
    action      NVARCHAR(50)  NOT NULL,              -- e.g. 'invoice.create', 'invoice.void', 'login.failed'
    entity      NVARCHAR(50)  NULL,
    entity_id   INT           NULL,
    detail      NVARCHAR(MAX) NULL,
    created_at  DATETIME2     NOT NULL CONSTRAINT DF_audit_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_audit_entity ON dbo.audit_log (entity, entity_id);

/* ---------- Starting data (edit the values, then run) ---------- */
INSERT INTO dbo.app_settings (id, business_name, business_address, gst_reg_no)
VALUES (1, N'Your Business Name', N'Your business address', NULL);

/* Set next_value to the number you want the FIRST new invoice to have,
   so numbering continues from your old system's last invoice. */
INSERT INTO dbo.number_sequences (seq_key, next_value) VALUES ('invoice', 1);
