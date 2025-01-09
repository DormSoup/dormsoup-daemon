import json
import yaml
import argparse
from pathlib import Path
from typing import Dict, Any, List, Union

def load_schema(input_path: Path) -> Dict[str, Any]:
    """
    Load schema from JSON or YAML file.
    
    Args:
        input_path: Path to the input file
        
    Returns:
        Dict containing the loaded schema
        
    Raises:
        ValueError: If file format is unsupported or parsing fails
    """
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
        
    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        if input_path.suffix.lower() in ['.yaml', '.yml']:
            return yaml.safe_load(content)
        elif input_path.suffix.lower() == '.json':
            return json.loads(content)
        else:
            raise ValueError(f"Unsupported file format: {input_path.suffix}")
    except (json.JSONDecodeError, yaml.YAMLError) as e:
        raise ValueError(f"Error parsing input file: {str(e)}")

def save_gbnf(gbnf: str, output_path: Path) -> None:
    """
    Save GBNF grammar to a file.
    
    Args:
        gbnf: The generated GBNF grammar
        output_path: Path where to save the output
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(gbnf)

def json_schema_to_gbnf(schema: Dict[str, Any]) -> str:
    """
    Convert a JSON Schema to GBNF (Grammar Backus-Naur Form) format.
    
    Args:
        schema (dict): A valid JSON Schema dictionary
        
    Returns:
        str: The GBNF representation of the schema
        
    Raises:
        ValueError: If schema is invalid or contains unsupported features
    """
    def process_property(name: str, definition: Dict[str, Any], is_required: bool) -> str:
        """Process a single property definition."""
        if not isinstance(definition, dict):
            raise ValueError(f"Invalid property definition for {name}")
            
        if "$ref" in definition:
            return process_ref(definition["$ref"])
            
        property_rule = f'"{name}" : {process_type(definition)}'
        if not is_required:
            property_rule += " | ε"  # Optional property
        return property_rule
    
    def process_ref(ref: str) -> str:
        """Process a JSON Schema reference."""
        return "<ref>"
    
    def process_type(definition: Dict[str, Any]) -> str:
        """Process a type definition."""
        if "type" not in definition:
            raise ValueError("Missing type in definition")
            
        prop_type = definition["type"]
        
        type_handlers = {
            "string": process_string,
            "integer": lambda _: "<integer>",
            "number": lambda _: "<number>",
            "boolean": lambda _: "<boolean>",
            "null": lambda _: "null",
            "array": process_array,
            "object": process_object
        }
        
        handler = type_handlers.get(prop_type)
        if not handler:
            raise ValueError(f"Unsupported type: {prop_type}")
            
        return handler(definition)
    
    def process_string(definition: Dict[str, Any]) -> str:
        """Process string type with various constraints."""
        if "enum" in definition:
            enum_values = " | ".join(f'"{v}"' for v in definition["enum"])
            return f"[{enum_values}]"
        
        if "pattern" in definition:
            return f"<pattern {definition['pattern']}>"
            
        if "format" in definition:
            formats = {
                "date-time": "<datetime>",
                "date": "<date>",
                "email": "<email>",
                "uri": "<uri>"
            }
            return formats.get(definition["format"], "<string>")
            
        return "<string>"
    
    def process_array(definition: Dict[str, Any]) -> str:
        """Process array type with its constraints."""
        if "items" not in definition:
            raise ValueError("Array definition missing items")
            
        items_type = process_type(definition["items"])
        
        min_items = definition.get("minItems", 0)
        max_items = definition.get("maxItems", "")
        
        if min_items == 0 and not max_items:
            return f"[{items_type}*]"
        elif min_items == 1 and not max_items:
            return f"[{items_type}+]"
        else:
            return f"[{items_type}]"
    
    def process_object(definition: Dict[str, Any]) -> str:
        """Process object type with its properties."""
        properties = definition.get("properties", {})
        required = set(definition.get("required", []))
        
        if not properties:
            return "{}"
            
        rules = []
        for name, prop in properties.items():
            try:
                rules.append(process_property(name, prop, name in required))
            except ValueError as e:
                raise ValueError(f"Error processing property '{name}': {str(e)}")
                
        additional_props = definition.get("additionalProperties", {})
        if additional_props:
            if isinstance(additional_props, bool):
                if additional_props:
                    rules.append('"*" : <any>')
            else:
                rules.append(f'"*" : {process_type(additional_props)}')
                
        return "{ " + ", ".join(rules) + " }"
    
    if not isinstance(schema, dict):
        raise ValueError("Schema must be a dictionary")
        
    if schema.get("type") != "object":
        raise ValueError("Root schema must be an object type")
        
    try:
        return process_object(schema)
    except Exception as e:
        raise ValueError(f"Error processing schema: {str(e)}")

def main():
    parser = argparse.ArgumentParser(description='Convert JSON Schema to GBNF grammar')
    parser.add_argument('input', type=Path, help='Input schema file (JSON or YAML)')
    parser.add_argument('output', type=Path, help='Output GBNF file')
    parser.add_argument('--pretty', action='store_true', help='Format output with indentation')
    
    args = parser.parse_args()
    
    try:
        # Load schema from file
        schema = load_schema(args.input)
        
        # Convert to GBNF
        gbnf = json_schema_to_gbnf(schema)
        
        # Format if requested
        if args.pretty:
            # Simple pretty formatting - could be enhanced
            gbnf = gbnf.replace("{", "{\n  ")
            gbnf = gbnf.replace("}", "\n}")
            gbnf = gbnf.replace(", ", ",\n  ")
        
        # Save to output file
        save_gbnf(gbnf, args.output)
        print(f"Successfully converted {args.input} to GBNF format at {args.output}")
        
    except Exception as e:
        print(f"Error: {str(e)}")
        exit(1)

if __name__ == "__main__":
    main()
