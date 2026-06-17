import os
import uuid
import json
import pandas as pd
from openai import OpenAI
from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from werkzeug.utils import secure_filename
from waitress import serve

load_dotenv()

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
OUTPUT_FOLDER = os.path.join(BASE_DIR, 'outputs')

try:
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)
except OSError:
    # Fallback for serverless environments (like Vercel) which have read-only file systems
    UPLOAD_FOLDER = '/tmp/uploads'
    OUTPUT_FOLDER = '/tmp/outputs'
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['OUTPUT_FOLDER'] = OUTPUT_FOLDER

# Initial validation rules
validation_rules = {
    'India': {'code': '+91', 'length': 10},
    'Singapore': {'code': '+65', 'length': 8},
    'USA': {'code': '+1', 'length': 10}
}

OPENAI_MODEL = os.environ.get('OPENAI_MODEL', 'gpt-4o-mini')

def build_local_insights(validation_summary):
    errors = validation_summary.get('errors', [])
    total_records = validation_summary.get('total_records', 0)
    valid_records = validation_summary.get('valid_records', 0)
    invalid_records = validation_summary.get('invalid_records', 0)

    field_counts = {}
    for error in errors:
        field = error.get('field', 'Unknown Field')
        field_counts[field] = field_counts.get(field, 0) + 1

    top_fields = sorted(field_counts.items(), key=lambda item: item[1], reverse=True)
    top_field_text = ', '.join([f'{field} ({count})' for field, count in top_fields[:5]]) or 'No recurring fields'

    suggested_fixes = []
    descriptions = ' '.join([str(error.get('description', '')).lower() for error in errors])
    if 'date' in descriptions:
        suggested_fixes.append('Normalize date values to YYYY-MM-DD before upload.')
    if 'phone' in descriptions:
        suggested_fixes.append('Check phone country rules and remove extra country-code digits where needed.')
    if 'duplicate' in descriptions:
        suggested_fixes.append('Deduplicate order IDs before exporting the clean file.')
    if 'missing' in descriptions:
        suggested_fixes.append('Fill required fields or reject rows with missing critical values.')
    if not suggested_fixes:
        suggested_fixes.append('Review the listed rows and update validation rules for repeated patterns.')

    return (
        'Summary\n'
        f'- Total records: {total_records}\n'
        f'- Valid records: {valid_records}\n'
        f'- Invalid records: {invalid_records}\n\n'
        'Main Issues\n'
        f'- Top affected fields: {top_field_text}\n\n'
        'Suggested Fixes\n'
        + '\n'.join([f'- {fix}' for fix in suggested_fixes])
        + '\n\nRecommended Rules\n'
        '- Keep required-field checks for IDs, payment mode, and dates.\n'
        '- Keep country-specific phone length rules updated.\n'
        '- Add format checks for email, amount, and date columns.'
    )

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    if os.path.exists(path):
        return send_from_directory('.', path)
    return "Not Found", 404


@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    filename = secure_filename(file.filename)
    unique_filename = f"{uuid.uuid4()}_{filename}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
    file.save(filepath)
    
    try:
        if filepath.endswith('.csv'):
            df = pd.read_csv(filepath, nrows=10)
        else:
            df = pd.read_excel(filepath, nrows=10)
        
        preview_data = json.loads(df.to_json(orient='records'))
        headers = df.columns.tolist()
        
        return jsonify({
            'message': 'File uploaded successfully',
            'filename': unique_filename,
            'headers': headers,
            'preview': preview_data
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/validate', methods=['POST'])
def validate_data():
    data = request.json
    filename = data.get('filename')
    if not filename:
        return jsonify({'error': 'Filename is required'}), 400
        
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404
        
    try:
        if filepath.endswith('.csv'):
            df = pd.read_csv(filepath)
        else:
            df = pd.read_excel(filepath)
            
        total_records = len(df)
        errors = []
        
        # Standardize column names for processing (lowercase, underscore)
        col_mapping = {col: col.lower().replace(' ', '_') for col in df.columns}
        process_df = df.rename(columns=col_mapping)
        
        for index, row in process_df.iterrows():
            row_errors = []
            row_num = index + 2 # Assuming 1-indexed and header is row 1
            
            # Missing Value Check (Order ID, Payment Mode)
            if 'order_id' in row and pd.isna(row['order_id']):
                row_errors.append({'field': 'Order ID', 'invalid_value': 'Empty', 'description': 'Order ID is missing'})
                
            # Date Validation
            if 'order_date' in row and not pd.isna(row['order_date']):
                try:
                    pd.to_datetime(row['order_date'], format='%Y-%m-%d')
                except ValueError:
                    row_errors.append({'field': 'Order Date', 'invalid_value': str(row['order_date']), 'description': 'Invalid format (Expected YYYY-MM-DD)'})
            
            # Phone Validation (simple mock logic based on rules)
            if 'phone_number' in row and not pd.isna(row['phone_number']):
                phone = str(row['phone_number'])
                country = row.get('country', '') if 'country' in row else ''
                if not pd.isna(country) and country in validation_rules:
                    rule = validation_rules[country]
                    digits = ''.join(filter(str.isdigit, phone))
                    # Remove country code if present at start for length check
                    code_digits = ''.join(filter(str.isdigit, rule['code']))
                    if digits.startswith(code_digits):
                        digits = digits[len(code_digits):]
                    if len(digits) != rule['length']:
                        row_errors.append({
                            'field': 'Phone Number', 
                            'invalid_value': phone, 
                            'description': f'Length mismatch for {country} (Expected {rule["length"]})'
                        })
            
            if row_errors:
                for err in row_errors:
                    err['row'] = row_num
                errors.extend(row_errors)
                
        # Duplicate check on Order ID
        if 'order_id' in process_df.columns:
            duplicates = process_df[process_df.duplicated('order_id', keep=False)]
            for index, row in duplicates.iterrows():
                if not pd.isna(row['order_id']):
                    # Only add if not already in errors (simplification)
                    errors.append({
                        'row': index + 2,
                        'field': 'Order ID',
                        'invalid_value': str(row['order_id']),
                        'description': 'Duplicate Order ID found'
                    })
                    
        # Filter to unique rows for valid count estimation (mock)
        # In a real app we'd keep track of completely valid rows
        error_rows = set([e['row'] for e in errors])
        invalid_records = len(error_rows)
        valid_records = total_records - invalid_records
        
        # Force output to be .csv regardless of input extension
        base_filename = os.path.splitext(filename)[0] + '.csv'
        
        # Save validation results
        clean_df = df.drop(index=[r - 2 for r in error_rows if (r - 2) < len(df)])
        clean_filepath = os.path.join(app.config['OUTPUT_FOLDER'], f"clean_{base_filename}")
        clean_df.to_csv(clean_filepath, index=False)
        
        error_df = pd.DataFrame(errors)
        error_filepath = os.path.join(app.config['OUTPUT_FOLDER'], f"errors_{base_filename}")
        if not error_df.empty:
            error_df.to_csv(error_filepath, index=False)
        
        return jsonify({
            'total_records': total_records,
            'valid_records': valid_records,
            'invalid_records': invalid_records,
            'errors': errors[:100], # Send top 100 for display
            'clean_file': f"clean_{base_filename}",
            'error_file': f"errors_{base_filename}" if not error_df.empty else None
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/rules', methods=['GET'])
def get_rules():
    return jsonify(validation_rules)

@app.route('/api/rules', methods=['POST'])
def add_or_update_rule():
    data = request.json
    country = data.get('country')
    code = data.get('code')
    length = data.get('length')
    
    if not country or not code or not length:
        return jsonify({'error': 'Missing rule fields'}), 400
        
    validation_rules[country] = {'code': code, 'length': int(length)}
    return jsonify({'message': 'Rule saved successfully', 'rules': validation_rules})

@app.route('/api/rules/<country>', methods=['DELETE'])
def delete_rule(country):
    if country in validation_rules:
        del validation_rules[country]
        return jsonify({'message': 'Rule deleted successfully', 'rules': validation_rules})
    return jsonify({'error': 'Rule not found'}), 404

@app.route('/api/split', methods=['POST'])
def split_file():
    data = request.json
    filename = data.get('filename')
    chunk_size = data.get('chunk_size', 1000)
    
    if not filename:
        return jsonify({'error': 'Filename is required'}), 400
        
    # Force clean_filename to use .csv so it can find the validated outputs
    base_filename = os.path.splitext(filename)[0] + '.csv'
    clean_filepath = os.path.join(app.config['OUTPUT_FOLDER'], f"clean_{base_filename}")
    orig_filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    
    filepath = clean_filepath if os.path.exists(clean_filepath) else orig_filepath
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404
        
    chunks_info = []
    try:
        if filepath.endswith('.csv'):
            chunk_iter = pd.read_csv(filepath, chunksize=chunk_size)
        else:
            # Excel splitting is trickier with chunksize, so load full
            df = pd.read_excel(filepath)
            chunk_iter = [df[i:i + chunk_size] for i in range(0, len(df), chunk_size)]
            
        base_name = os.path.splitext(secure_filename(filename))[0]
        for i, chunk in enumerate(chunk_iter):
            chunk_name = f"{base_name}_chunk_{i+1}_{chunk_size}.csv"
            chunk_path = os.path.join(app.config['OUTPUT_FOLDER'], chunk_name)
            chunk.to_csv(chunk_path, index=False)
            chunks_info.append({
                'filename': chunk_name,
                'rows': len(chunk)
            })
            
        return jsonify({'chunks': chunks_info})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/ai/insights', methods=['POST'])
def ai_insights():
    data = request.json or {}
    validation_summary = {
        'total_records': data.get('total_records', 0),
        'valid_records': data.get('valid_records', 0),
        'invalid_records': data.get('invalid_records', 0),
        'errors': data.get('errors', [])[:50]
    }

    api_key = os.environ.get('OPENAI_API_KEY')
    if not api_key or api_key == 'your_openai_api_key_here':
        return jsonify({
            'model': 'local-fallback',
            'source': 'local',
            'insights': build_local_insights(validation_summary),
            'warning': 'OPENAI_API_KEY is not configured, so local insights were generated.'
        })

    prompt = (
        'You are an AI data quality assistant for Zentro. '
        'Analyze this validation result and return concise, practical guidance. '
        'Use short sections: Summary, Main Issues, Suggested Fixes, Recommended Rules. '
        'Do not invent row numbers or fields that are not in the data.\n\n'
        f'Validation result JSON:\n{json.dumps(validation_summary, ensure_ascii=False)}'
    )

    try:
        client = OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {'role': 'system', 'content': 'You are a concise data quality assistant.'},
                {'role': 'user', 'content': prompt}
            ],
            temperature=0.2,
            max_tokens=700
        )
        text = response.choices[0].message.content.strip()
        if not text:
            return jsonify({'error': 'OpenAI returned an empty response.'}), 502

        return jsonify({
            'model': OPENAI_MODEL,
            'source': 'openai',
            'insights': text
        })
    except Exception as e:
        detail = str(e)[:500]
        return jsonify({
            'model': 'local-fallback',
            'source': 'local',
            'insights': build_local_insights(validation_summary),
            'warning': f'OpenAI request failed, so local insights were generated instead. Details: {detail}'
        })

@app.route('/api/download/<filename>', methods=['GET'])
def download_file(filename):
    return send_from_directory(app.config['OUTPUT_FOLDER'], filename, as_attachment=True)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    if os.environ.get('FLASK_DEBUG') == '1':
        app.run(debug=True, port=port, host='0.0.0.0')
    else:
        serve(app, host='0.0.0.0', port=port)
