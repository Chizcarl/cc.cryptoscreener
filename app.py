import os
import pandas as pd
import numpy as np
from tradingview_screener import Query, col
from datetime import datetime, timezone
import threading
import json
from flask import (
    Flask, render_template, request, jsonify, redirect, url_for, flash, session, send_from_directory
)
import math
from sqlalchemy import (
    create_engine, text, exc as sqlalchemy_exc, Column, Integer, String,
    Boolean, ForeignKey, TIMESTAMP, UniqueConstraint, Float
)
from sqlalchemy.orm import sessionmaker, declarative_base, relationship
from sqlalchemy.sql import func
from dotenv import load_dotenv
import warnings
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user, login_required, current_user
)
from functools import wraps
import logging
from flask_talisman import Talisman
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_wtf.csrf import CSRFProtect

warnings.filterwarnings('ignore', category=DeprecationWarning, module='sqlalchemy.*')
load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY")
if not app.secret_key:
    raise ValueError("No FLASK_SECRET_KEY set for Flask application")

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax'
)

csrf = CSRFProtect(app)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://",
    strategy="fixed-window"
)

csp = {
    'default-src': ["'self'"],
    'script-src': [
        "'self'",
        's3.tradingview.com',
        "'unsafe-inline'"
    ],
    'style-src': ["'self'", 'fonts.googleapis.com', "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', '*.tradingview.com'],
    'font-src': ["'self'", 'fonts.gstatic.com'],
    'connect-src': ["'self'", '*.tradingview.com', 'tradingview-widget.com'],
    'frame-src': ["'self'", '*.tradingview.com', 'tradingview-widget.com']
}

talisman = Talisman(
    app,
    content_security_policy=csp,
    content_security_policy_nonce_in=['script-src'],
    force_https=True,
    strict_transport_security=True,
    session_cookie_secure=True,
    session_cookie_http_only=True
)

logging.basicConfig(level=logging.INFO)

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("No DATABASE_URL set for Flask application")

try:
    engine_url = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
    engine = create_engine(engine_url, pool_size=5, max_overflow=10, echo=False)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base = declarative_base()
    app.logger.info("SQLAlchemy engine and session configured.")
except Exception as e:
    app.logger.error(f"Error creating SQLAlchemy engine: {e}", exc_info=True)
    engine = None
    SessionLocal = None
    Base = None

class User(Base, UserMixin):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    is_admin = Column(Boolean, default=False, nullable=False)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    watchlist_items = relationship("WatchlistItem", back_populates="owner", cascade="all, delete-orphan")

class WatchlistItem(Base):
    __tablename__ = "watchlist"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(50), nullable=False, index=True)
    grade = Column(String(1), nullable=False)
    price_at_add = Column(Float)
    volume_at_add = Column(String(20))
    rsi_4hr_at_add = Column(Float)
    rsi_d_at_add = Column(Float)
    ema_4hr_at_add = Column(String(10))
    ema_d_at_add = Column(String(10))
    rating_at_add = Column(Integer)
    added_timestamp = Column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    owner = relationship("User", back_populates="watchlist_items")
    __table_args__ = (UniqueConstraint('user_id', 'name', name='uq_user_watchlist_item'),)

login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'
login_manager.login_message_category = 'info'
login_manager.login_message = "Please log in to access this page."

@login_manager.user_loader
def load_user(user_id):
    if not SessionLocal: return None
    db = SessionLocal()
    user = None
    try:
        user = db.get(User, int(user_id))
    except Exception as e:
        app.logger.error(f"Error loading user {user_id}: {e}", exc_info=True)
    finally:
        db.close()
    return user

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            flash("Admin access required.", "warning")
            return redirect(url_for('index'))
        return f(*args, **kwargs)
    return decorated_function

def init_db():
    if not engine or not Base:
        app.logger.error("Cannot initialize DB: SQLAlchemy engine or Base not available.")
        return
    try:
        app.logger.info("Creating database tables...")
        Base.metadata.create_all(bind=engine)
        app.logger.info("Database tables checked/created using SQLAlchemy.")
    except sqlalchemy_exc.SQLAlchemyError as e:
        app.logger.error(f"SQLAlchemy Error initializing database: {e}", exc_info=True)
    except Exception as e:
        app.logger.error(f"An unexpected error occurred during DB init: {e}", exc_info=True)

data_frame = pd.DataFrame()
data_lock = threading.Lock()
last_fetched_exchange = 'BYBIT'

WATCHLIST_LIMIT = 50
DEFAULT_PER_PAGE = 50
ALLOWED_EXCHANGES = ['BYBIT', 'BINANCE', 'OKX', 'MEXC', 'BITGET']

def format_value(value):
    if pd.isna(value): return "N/A"
    if isinstance(value, (int, float)):
        if abs(value) >= 1_000_000_000: return f"{value / 1_000_000_000:.2f}B"
        elif abs(value) >= 1_000_000: return f"{value / 1_000_000:.2f}M"
        elif abs(value) >= 1_000: return f"{value / 1_000:.2f}K"
        else: return f"{value:.2f}"
    return str(value)

def classify_ema(row):
    def classify(timeframe_suffix):
        close = row.get(f'close{timeframe_suffix}', float('nan'))
        EMA20 = row.get(f'EMA20{timeframe_suffix}', float('nan'))
        EMA50 = row.get(f'EMA50{timeframe_suffix}', float('nan'))
        EMA100 = row.get(f'EMA100{timeframe_suffix}', float('nan'))
        if pd.isna(close) or pd.isna(EMA20) or pd.isna(EMA50) or pd.isna(EMA100): return "N/A"
        if close > EMA20 > EMA50 > EMA100: return "AOTS+"
        elif close < EMA20 < EMA50 < EMA100: return "iAOTS+"
        elif close > EMA100: return "ZS";
        elif close < EMA100: return "iZS";
        elif EMA20 > EMA50 > EMA100: return "AOTS";
        elif EMA20 < EMA50 < EMA100: return "iAOTS";
        else: return "Spaghetti"
    ema_status_240 = classify('|240'); ema_status_daily = classify('')
    return pd.Series([ema_status_240, ema_status_daily])

def calculate_ema_score(ema_class, close, ema20, ema50):
    if pd.isna(close): return 0
    if ema_class == 'AOTS+': return 5;
    if ema_class == 'AOTS': return 4;
    if ema_class == 'ZS': return 3;
    if ema_class == 'iAOTS+': return -5;
    if ema_class == 'iAOTS': return -4;
    if ema_class == 'iZS': return -3
    ema20_val = ema20 if not pd.isna(ema20) else float('-inf')
    ema50_val = ema50 if not pd.isna(ema50) else float('-inf')
    if close > ema50_val: return 2;
    if close > ema20_val: return 1;
    ema20_val_neg = ema20 if not pd.isna(ema20) else float('inf')
    ema50_val_neg = ema50 if not pd.isna(ema50) else float('inf')
    if close < ema20_val_neg: return -1;
    if close < ema50_val_neg: return -2;
    return 0

def calculate_rsi_score(rsi_val):
    if rsi_val is None or pd.isna(rsi_val): return 0
    try: rsi = float(rsi_val)
    except (ValueError, TypeError): return 0
    if rsi >= 70: return 3;
    if rsi >= 60: return 2;
    if rsi >= 50: return 1;
    if rsi <= 30: return -3;
    if rsi <= 40: return -2;
    return 0

def calculate_final_rating(row):
    ema_4h_score = calculate_ema_score(row.get('EMA_Class_4hr', 'N/A'), row.get('close|240_original'), row.get('EMA20|240_original'), row.get('EMA50|240_original'))
    ema_d_score = calculate_ema_score(row.get('EMA_Class_Daily', 'N/A'), row.get('close_original'), row.get('EMA20_original'), row.get('EMA50_original'))
    rsi_4h_score = calculate_rsi_score(row.get('RSI|240_original'))
    rsi_d_score = calculate_rsi_score(row.get('RSI_original'))
    total_score = ema_4h_score + ema_d_score + rsi_4h_score + rsi_d_score
    if total_score >= 10: return 5;
    elif total_score >= 6: return 4;
    elif total_score >= 2: return 3;
    elif total_score >= -2: return 2;
    elif total_score >= -6: return 1;
    else: return 0

def fetch_and_process_data(selected_exchange='BYBIT'):
    global data_frame, last_fetched_exchange
    app.logger.info(f"Attempting data fetch for exchange: {selected_exchange}...")
    if selected_exchange not in ALLOWED_EXCHANGES:
        app.logger.error(f"Invalid exchange requested: {selected_exchange}")
        selected_exchange = 'BYBIT' # Fallback to default

    try:
        fetch_cols = [
            'name', 'close', 'close|240', 'change', 'change|240', 'EMA20|240', 'EMA50|240',
            'EMA100|240', 'RSI|240', 'RSI', 'EMA20', 'EMA50', 'EMA100', 'volume', 'volume|240',
            'Value.Traded|240', 'Value.Traded',
            'ATR', 'ATRP', 'High.1M', 'High.3M', 'High.5D', 'High.6M', 'High.All',
            'Low.1M', 'Low.3M', 'Low.5D', 'Low.6M', 'Low.All', 'Perf.1M', 'Perf.3M', 'Perf.5D',
            'Perf.6M', 'Perf.All', 'Perf.W', 'Perf.Y', 'Perf.YTD', 'VWAP', 'VWMA',
            'Volatility.D', 'Volatility.M', 'Volatility.W', 'price_52_week_high', 'price_52_week_low',
            'average_volume_10d_calc', 'average_volume_30d_calc', 'average_volume_60d_calc', 'average_volume_90d_calc',
            'volume_change'
        ]
        query = (Query().limit(1000).select(*fetch_cols)
            .where(
                col('exchange') == selected_exchange,
                col('type').isin(['swap']),
                col('typespecs').has('perpetual'),
                col('currency').like('USDT')
            ).set_markets('crypto').get_scanner_data()
        )
        with data_lock:
            new_df = pd.DataFrame()
            if query and len(query) > 1 and isinstance(query[1], pd.DataFrame) and not query[1].empty:
                df = query[1].copy()
                original_cols_needed = ['volume|240', 'volume', 'close|240', 'close', 'RSI|240', 'RSI',
                                       'EMA20|240', 'EMA50|240', 'EMA100|240', 'EMA20', 'EMA50', 'EMA100']
                for col_name in original_cols_needed:
                    if col_name in df.columns: df[f'{col_name}_original'] = pd.to_numeric(df[col_name], errors='coerce')
                    else: df[f'{col_name}_original'] = np.nan
                df[['EMA_Class_4hr', 'EMA_Class_Daily']] = df.apply(classify_ema, axis=1, result_type="expand")
                df['rating'] = df.apply(calculate_final_rating, axis=1)
                columns_to_format = ['volume', 'volume|240', 'Value.Traded|240', 'Value.Traded', 'close', 'close|240',
                                    'High.1M', 'Low.1M','High.3M', 'Low.3M','High.5D', 'Low.5D', 'High.6M', 'Low.6M',
                                    'High.All','Low.All','price_52_week_high', 'price_52_week_low', 'VWAP', 'VWMA',
                                    'average_volume_10d_calc', 'average_volume_30d_calc', 'average_volume_60d_calc', 'average_volume_90d_calc']
                percentage_cols = ['change', 'change|240', 'ATRP', 'Perf.1M', 'Perf.3M', 'Perf.5D', 'Perf.6M',
                                   'Perf.All', 'Perf.W', 'Perf.Y', 'Perf.YTD', 'Volatility.D', 'Volatility.M', 'Volatility.W', 'volume_change']
                numeric_cols = ['ATR', 'RSI|240', 'RSI']
                for col_name in df.columns:
                    if col_name in columns_to_format:
                        df[col_name] = df[col_name].apply(lambda x: format_value(pd.to_numeric(x, errors='coerce')))
                    elif col_name in percentage_cols:
                        df[col_name] = pd.to_numeric(df[col_name], errors='coerce').apply(lambda x: f"{x:.2f}%" if pd.notnull(x) else "N/A")
                    elif col_name in numeric_cols:
                         df[col_name] = pd.to_numeric(df[col_name], errors='coerce').round(2)
                for col_name in fetch_cols:
                     if col_name not in df.columns: df[col_name] = np.nan
                if 'rating' not in df.columns: df['rating'] = 0
                if 'RSI_original' not in df.columns: df['RSI_original'] = np.nan
                df = df.replace([np.inf, -np.inf], np.nan)
                new_df = df.where(pd.notnull(df), None)
                app.logger.info(f"Data fetched for {selected_exchange}. Shape: {new_df.shape}")
            else:
                app.logger.error(f"Error: No valid data received from TradingView for {selected_exchange}.")

            data_frame = new_df
            last_fetched_exchange = selected_exchange

    except Exception as e:
        app.logger.error(f"Error fetching/processing data for {selected_exchange}: {e}", exc_info=True)
        with data_lock:
            data_frame = pd.DataFrame()
            last_fetched_exchange = selected_exchange


def clean_for_json(data_list):
    cleaned_list = []
    if not isinstance(data_list, list): return data_list
    for record in data_list:
        cleaned_record = {}
        if isinstance(record, dict):
            for key, value in record.items():
                if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                    cleaned_record[key] = None
                elif isinstance(value, datetime):
                     cleaned_record[key] = value.isoformat()
                elif pd.isna(value):
                     cleaned_record[key] = None
                else:
                    cleaned_record[key] = value
            cleaned_list.append(cleaned_record)
        else:
             try:
                 cleaned_list.append(dict(record))
             except TypeError:
                 cleaned_list.append(record)
    return cleaned_list

@app.before_request
def before_request():
    session.setdefault('selected_exchange', 'BYBIT')

@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("10 per minute")
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        remember = True if request.form.get('remember') else False
        if not username or not password:
            flash('Username and password required.', 'warning')
            return redirect(url_for('login'))
        db = SessionLocal()
        user = None
        try:
            user = db.query(User).filter_by(username=username).first()
        except Exception as e:
            app.logger.error(f"Database error during login for {username}: {e}", exc_info=True)
            flash('An error occurred during login.', 'danger')
            db.close()
            return redirect(url_for('login'))
        finally:
            db.close()
        if not user or not check_password_hash(user.password_hash, password):
            flash('Invalid username or password.', 'danger')
            return redirect(url_for('login'))
        login_user(user, remember=remember)
        session['selected_exchange'] = 'BYBIT' # Reset exchange on login
        flash('Logged in successfully.', 'success')
        next_page = request.args.get('next')
        return redirect(next_page or url_for('index'))
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    session.pop('selected_exchange', None)
    flash('You have been logged out.', 'success')
    return redirect(url_for('login'))

@app.route('/register', methods=['GET', 'POST'])
@limiter.limit("5 per hour")
@login_required
@admin_required
def register():
    if request.method == 'POST':
        # REMOVED Manual CSRF check
        username = request.form.get('username')
        password = request.form.get('password')
        is_admin = True if request.form.get('is_admin') else False
        if not username or not password:
            flash('Username and password required.', 'warning')
            return redirect(url_for('register'))
        db = SessionLocal()
        try:
            existing_user = db.query(User).filter_by(username=username).first()
            if existing_user:
                flash('Username already exists.', 'warning')
                db.close()
                return redirect(url_for('register'))
            hashed_password = generate_password_hash(password, method='pbkdf2:sha256')
            new_user = User(username=username, password_hash=hashed_password, is_admin=is_admin)
            db.add(new_user)
            db.commit()
            flash(f'User {username} created successfully.', 'success')
            return redirect(url_for('index'))
        except Exception as e:
            db.rollback()
            app.logger.error(f"Error registering user: {e}", exc_info=True)
            flash('Error creating user.', 'danger')
            return redirect(url_for('register'))
        finally:
            db.close()
    return render_template('register.html')

@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'),
                               'favicon.ico', mimetype='image/vnd.microsoft.icon')

@app.route('/')
def index():
    return render_template('index.html',
                           allowed_exchanges=ALLOWED_EXCHANGES,
                           selected_exchange=session.get('selected_exchange', 'BYBIT'))

@app.route('/data/screener', methods=['GET'])
def get_screener_data():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', DEFAULT_PER_PAGE, type=int)
    per_page = max(1, min(per_page, 100))
    start = (page - 1) * per_page
    end = start + per_page

    with data_lock:
        current_df = data_frame.copy()
        current_exchange = last_fetched_exchange

        if current_df is None or current_df.empty:
            return jsonify({
                "error": "Data not available yet.", "data": [],
                "pagination": {"current_page": 1, "total_pages": 0, "total_items": 0, "per_page": per_page, "has_prev": False, "has_next": False},
                "exchange": current_exchange
             }), 503

        total_items = len(current_df)
        total_pages = math.ceil(total_items / per_page) if per_page > 0 else 0
        paginated_df = current_df.iloc[start:end] if total_items > 0 else pd.DataFrame()

        all_display_cols = [
            'name', 'close|240', 'volume', 'RSI|240', 'RSI', 'EMA_Class_4hr', 'EMA_Class_Daily', 'rating', 'RSI_original',
            'ATR', 'ATRP', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M', 'High.5D', 'Low.5D', 'High.6M', 'Low.6M',
            'High.All', 'Low.All', 'Perf.1M', 'Perf.3M', 'Perf.5D', 'Perf.6M', 'Perf.All', 'Perf.W', 'Perf.Y', 'Perf.YTD',
            'VWAP', 'VWMA', 'Value.Traded', 'Volatility.D', 'Volatility.M', 'Volatility.W',
            'price_52_week_high', 'price_52_week_low', 'average_volume_10d_calc', 'average_volume_30d_calc',
            'average_volume_60d_calc', 'average_volume_90d_calc', 'volume_change', 'change', 'change|240'
        ]
        available_cols = [col for col in all_display_cols if col in paginated_df.columns]
        df_display = paginated_df[available_cols].copy() if not paginated_df.empty else pd.DataFrame()
        screener_data_list = df_display.to_dict(orient='records') if not df_display.empty else []
        cleaned_data = clean_for_json(screener_data_list)

        pagination_data = {
            "current_page": page,
            "total_pages": total_pages,
            "total_items": total_items,
            "per_page": per_page,
            "has_prev": page > 1,
            "has_next": page < total_pages
        }

        return jsonify({
            "data": cleaned_data,
            "pagination": pagination_data,
            "exchange": current_exchange
        })

@app.route('/settings/exchange', methods=['POST'])
@limiter.limit("10 per minute")
def set_exchange():
    data = request.get_json()
    new_exchange = data.get('exchange')
    if new_exchange and new_exchange in ALLOWED_EXCHANGES:
        session['selected_exchange'] = new_exchange
        app.logger.info(f"User {current_user.id if current_user.is_authenticated else 'Guest'} set exchange to {new_exchange}")
        thread = threading.Thread(target=fetch_and_process_data, args=(new_exchange,))
        thread.start()
        return jsonify({"success": True, "message": f"Exchange set to {new_exchange}. Refreshing data...", "exchange": new_exchange})
    else:
        return jsonify({"success": False, "message": "Invalid exchange provided."}), 400


@app.route('/data/refresh', methods=['POST'])
@limiter.limit("10 per hour")
@login_required
def refresh_data():
    current_exchange = session.get('selected_exchange', 'BYBIT')
    app.logger.info(f"Manual refresh triggered for exchange: {current_exchange} by user {current_user.id}")
    thread = threading.Thread(target=fetch_and_process_data, args=(current_exchange,))
    thread.start()
    return jsonify({"message": f"Data refresh initiated for {current_exchange}."})

@app.route('/filter/alpha', methods=['POST'])
def filter_alpha():
     with data_lock:
        current_df = data_frame.copy()
        current_exchange = last_fetched_exchange
        if current_df is None or current_df.empty:
            return jsonify({
                "error": "Data not available.", "data": [],
                "pagination": {"current_page": 1, "total_pages": 0, "total_items": 0, "per_page": DEFAULT_PER_PAGE, "has_prev": False, "has_next": False},
                "exchange": current_exchange
                }), 503
        try:
            criteria = request.get_json()
            ema_4hr = criteria.get('ema4hr', 'None'); rsi_4hr = criteria.get('rsi4hr', 'None')
            ema_daily = criteria.get('emaDaily', 'None'); rsi_daily = criteria.get('rsiDaily', 'None')

            filtered_df = current_df # Start with the full dataset for the current exchange
            if ema_4hr != "None" and f'EMA{ema_4hr}|240_original' in filtered_df.columns and 'close|240_original' in filtered_df.columns:
                ema_col = f'EMA{ema_4hr}|240_original'
                filtered_df = filtered_df[pd.to_numeric(filtered_df['close|240_original'], errors='coerce') > pd.to_numeric(filtered_df[ema_col], errors='coerce')]
            if rsi_4hr != "None" and 'RSI|240_original' in filtered_df.columns:
                 threshold = float(rsi_4hr)
                 filtered_df = filtered_df[pd.to_numeric(filtered_df['RSI|240_original'], errors='coerce') > threshold]
            if ema_daily != "None" and f'EMA{ema_daily}_original' in filtered_df.columns and 'close_original' in filtered_df.columns:
                ema_col = f'EMA{ema_daily}_original'
                filtered_df = filtered_df[pd.to_numeric(filtered_df['close_original'], errors='coerce') > pd.to_numeric(filtered_df[ema_col], errors='coerce')]
            if rsi_daily != "None" and 'RSI_original' in filtered_df.columns:
                threshold = float(rsi_daily)
                filtered_df = filtered_df[pd.to_numeric(filtered_df['RSI_original'], errors='coerce') > threshold]

            page = request.args.get('page', 1, type=int)
            per_page = request.args.get('per_page', DEFAULT_PER_PAGE, type=int)
            per_page = max(1, min(per_page, 100))
            start = (page - 1) * per_page
            end = start + per_page

            total_items = len(filtered_df)
            total_pages = math.ceil(total_items / per_page) if per_page > 0 else 0
            paginated_df = filtered_df.iloc[start:end] if total_items > 0 else pd.DataFrame()

            all_display_cols = [
                'name', 'close|240', 'volume', 'RSI|240', 'RSI', 'EMA_Class_4hr', 'EMA_Class_Daily', 'rating', 'RSI_original',
                 'ATR', 'ATRP', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M', 'High.5D', 'Low.5D', 'High.6M', 'Low.6M',
                 'High.All', 'Low.All', 'Perf.1M', 'Perf.3M', 'Perf.5D', 'Perf.6M', 'Perf.All', 'Perf.W', 'Perf.Y', 'Perf.YTD',
                 'VWAP', 'VWMA', 'Value.Traded', 'Volatility.D', 'Volatility.M', 'Volatility.W',
                 'price_52_week_high', 'price_52_week_low', 'average_volume_10d_calc', 'average_volume_30d_calc',
                 'average_volume_60d_calc', 'average_volume_90d_calc', 'volume_change', 'change', 'change|240'
            ]
            available_cols = [col for col in all_display_cols if col in paginated_df.columns]
            df_display = paginated_df[available_cols].copy() if not paginated_df.empty else pd.DataFrame()
            result_data_list = df_display.to_dict(orient='records') if not df_display.empty else []
            cleaned_data = clean_for_json(result_data_list)

            pagination_data = {
                "current_page": page,
                "total_pages": total_pages,
                "total_items": total_items,
                "per_page": per_page,
                "has_prev": page > 1,
                "has_next": page < total_pages
            }
            return jsonify({
                "data": cleaned_data,
                "pagination": pagination_data,
                "exchange": current_exchange
            })
        except Exception as e:
            app.logger.error(f"Filter error: {e}", exc_info=True)
            return jsonify({"error": "An error occurred during filtering.", "data": [], "pagination": {}}), 500

@app.route('/watchlist', methods=['GET'])
@login_required
def get_watchlist_route():
    if not SessionLocal:
        app.logger.error("Database session factory (SessionLocal) not available.")
        return jsonify({"error": "Database connection not configured.", "data": [], "pagination": {}}), 503

    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', DEFAULT_PER_PAGE, type=int)
    per_page = max(1, min(per_page, 100))
    offset = (page - 1) * per_page

    watchlist_base_data = []
    db = SessionLocal()
    try:
        query_base = db.query(WatchlistItem).filter(WatchlistItem.user_id == current_user.id)
        total_items = query_base.count()
        total_pages = math.ceil(total_items / per_page) if per_page > 0 else 0

        watchlist_items_orm = query_base.order_by(WatchlistItem.added_timestamp.desc())\
                                        .limit(per_page)\
                                        .offset(offset)\
                                        .all()

        for item in watchlist_items_orm:
            ts = item.added_timestamp
            watchlist_base_data.append({
                "name": item.name,
                "grade": item.grade,
                "date_added": ts.strftime("%Y-%m-%d") if ts else "N/A",
                "time_added": ts.strftime("%H:%M:%S") if ts else "N/A"
            })
    except Exception as e:
        app.logger.error(f"Error loading watchlist for user {current_user.id}: {e}", exc_info=True)
        db.close()
        return jsonify({"error": "Failed to load watchlist.", "data": [], "pagination": {}}), 500
    finally:
        db.close()

    merged_watchlist = []
    with data_lock:
        live_data_map = {}
        df_copy = data_frame.copy() if data_frame is not None else pd.DataFrame()
        current_exchange = last_fetched_exchange

    if not df_copy.empty:
        live_data_cols = ['name', 'close|240', 'volume', 'RSI|240', 'RSI',
                          'EMA_Class_4hr', 'EMA_Class_Daily', 'rating',
                          'ATR', 'ATRP', 'High.1M', 'Low.1M', 'High.3M', 'Low.3M', 'High.5D', 'Low.5D', 'High.6M', 'Low.6M',
                          'High.All', 'Low.All', 'Perf.1M', 'Perf.3M', 'Perf.5D', 'Perf.6M', 'Perf.All', 'Perf.W', 'Perf.Y', 'Perf.YTD',
                          'VWAP', 'VWMA', 'Value.Traded', 'Volatility.D', 'Volatility.M', 'Volatility.W',
                          'price_52_week_high', 'price_52_week_low', 'average_volume_10d_calc', 'average_volume_30d_calc',
                          'average_volume_60d_calc', 'average_volume_90d_calc', 'volume_change', 'change', 'change|240']
        available_live_cols = [col for col in live_data_cols if col in df_copy.columns]
        live_data_map_df = df_copy[available_live_cols].copy()
        live_data_map = live_data_map_df.set_index('name').to_dict(orient='index')

    for item_dict in watchlist_base_data:
        live_info = live_data_map.get(item_dict['name'])
        merged_item = {
            "date_added": item_dict['date_added'],
            "time_added": item_dict['time_added'],
            "name": item_dict['name'],
            "price": live_info.get('close|240', 'N/A') if live_info else "N/A",
            "volume": live_info.get('volume', 'N/A') if live_info else "N/A",
            "rsi_4hr": live_info.get('RSI|240', None) if live_info else None,
            "rsi_d": live_info.get('RSI', None) if live_info else None,
            "ema_4hr": live_info.get('EMA_Class_4hr', 'N/A') if live_info else "N/A",
            "ema_d": live_info.get('EMA_Class_Daily', 'N/A') if live_info else "N/A",
            "grade": item_dict['grade'],
            "rating": live_info.get('rating', 0) if live_info else 0,
            **( {k: live_info.get(k, None) for k in available_live_cols if k != 'name'} if live_info else \
                 {k: None for k in available_live_cols if k != 'name'} )
        }
        merged_watchlist.append(merged_item)

    cleaned_data = clean_for_json(merged_watchlist)
    pagination_data = {
        "current_page": page,
        "total_pages": total_pages,
        "total_items": total_items,
        "per_page": per_page,
        "has_prev": page > 1,
        "has_next": page < total_pages
    }

    return jsonify({"data": cleaned_data, "pagination": pagination_data})

@app.route('/watchlist/add', methods=['POST'])
@limiter.limit("60 per minute")
@login_required
def add_to_watchlist_route():
    if not SessionLocal: return jsonify({"success": False, "message": "Database session not available."}), 503
    db = SessionLocal()
    try:
        current_count = db.query(func.count(WatchlistItem.id)).filter_by(user_id=current_user.id).scalar()
        if current_count >= WATCHLIST_LIMIT:
             db.close()
             return jsonify({"success": False, "message": f"Watchlist limit ({WATCHLIST_LIMIT} items) reached."}), 400

        data = request.get_json()
        item_data = data.get('itemData')
        grade = data.get('grade', 'N/A')

        if not item_data or len(item_data) < 8:
            return jsonify({"success": False, "message": "Invalid data received."}), 400

        name, price_str, volume_str, rsi4hr_str, rsi_d_str, ema4hr, ema_d, rating_val = item_data[:8]

        exists = db.query(WatchlistItem.id).filter_by(user_id=current_user.id, name=name).first()
        if exists:
             return jsonify({"success": False, "message": f"{name} already exists in your watchlist."}), 409

        def safe_float_from_str(val_str):
            if val_str is None or val_str == "N/A": return None
            try:
                cleaned_str = ''.join(c for c in str(val_str) if c.isdigit() or c == '.' or c == '-')
                return float(cleaned_str)
            except (ValueError, TypeError):
                return None
        def safe_int(val):
            try: return int(val)
            except (ValueError, TypeError): return None

        new_item = WatchlistItem(
            user_id=current_user.id,
            name=name, grade=grade,
            price_at_add=safe_float_from_str(price_str),
            volume_at_add=str(volume_str) if volume_str is not None else None,
            rsi_4hr_at_add=safe_float_from_str(rsi4hr_str),
            rsi_d_at_add=safe_float_from_str(rsi_d_str),
            ema_4hr_at_add=ema4hr, ema_d_at_add=ema_d,
            rating_at_add=safe_int(rating_val)
        )
        db.add(new_item)
        db.commit()
        return jsonify({"success": True, "message": "Added to watchlist."})

    except sqlalchemy_exc.IntegrityError as e:
         db.rollback()
         app.logger.warning(f"Integrity error adding watchlist item for user {current_user.id}: {e}")
         return jsonify({"success": False, "message": f"{name} already exists in your watchlist (DB)."}), 409
    except Exception as e:
        db.rollback()
        app.logger.error(f"Error adding to watchlist for user {current_user.id}: {e}", exc_info=True)
        return jsonify({"success": False, "message": "Server error adding item."}), 500
    finally:
        db.close()

@app.route('/watchlist/delete', methods=['POST'])
@limiter.limit("120 per minute")
@login_required
def delete_from_watchlist_route():
    if not SessionLocal: return jsonify({"success": False, "message": "Database session not available."}), 503
    db = SessionLocal()
    try:
        data = request.get_json()
        item_name = data.get('name')
        if not item_name:
            return jsonify({"success": False, "message": "Name missing."}), 400

        item_to_delete = db.query(WatchlistItem).filter_by(user_id=current_user.id, name=item_name).first()

        if item_to_delete:
            db.delete(item_to_delete)
            db.commit()
            return jsonify({"success": True, "message": "Removed."})
        else:
            return jsonify({"success": False, "message": "Item not found in your watchlist."}), 404
    except Exception as e:
        db.rollback()
        app.logger.error(f"Error deleting watchlist item for user {current_user.id}: {e}", exc_info=True)
        return jsonify({"success": False, "message": "Server error deleting item."}), 500
    finally:
        db.close()

@app.route('/watchlist/delete_all', methods=['POST'])
@limiter.limit("5 per hour")
@login_required
def delete_all_watchlist_route():
    if not SessionLocal: return jsonify({"success": False, "message": "Database session not available."}), 503
    db = SessionLocal()
    try:
        deleted_count = db.query(WatchlistItem).filter_by(user_id=current_user.id).delete()
        db.commit()
        app.logger.info(f"Deleted {deleted_count} watchlist items for user {current_user.id}.")
        return jsonify({"success": True, "message": "Watchlist cleared."})
    except Exception as e:
        db.rollback()
        app.logger.error(f"Error clearing watchlist for user {current_user.id}: {e}", exc_info=True)
        return jsonify({"success": False, "message": "Server error clearing watchlist."}), 500
    finally:
        db.close()

@app.route('/watchlist/copy_data', methods=['GET'])
@login_required
def get_watchlist_copy_data():
    if not SessionLocal: return jsonify({"success": False, "message": "Database session not available."}), 503
    db = SessionLocal()
    watchlist_items = []
    try:
        watchlist_items = db.query(WatchlistItem.name, WatchlistItem.grade)\
                            .filter(WatchlistItem.user_id == current_user.id)\
                            .order_by(WatchlistItem.grade.asc(), WatchlistItem.name.asc())\
                            .all()
        formatted_lines = [f"{item.name} - Grade: {item.grade}" for item in watchlist_items]
        copy_text = "\n".join(formatted_lines)
        return jsonify({"success": True, "text": copy_text})
    except Exception as e:
        app.logger.error(f"Error copying watchlist data for user {current_user.id}: {e}", exc_info=True)
        return jsonify({"success": False, "message": "Server error retrieving watchlist data."}), 500
    finally:
        db.close()

def initial_fetch():
    app.logger.info("Performing initial data fetch on startup...")
    fetch_and_process_data('BYBIT')

if __name__ == '__main__':
    init_db()
    initial_fetch()
    app.logger.info("Starting Flask app...")
    app.run(debug=False, host='0.0.0.0', port=int(os.environ.get("PORT", 5000)))
else:
    init_db()
    initial_fetch()
